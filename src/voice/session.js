import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
} from '@discordjs/voice';
import prism from 'prism-media';
import { pcmToWav, transcribe, pcmDurationSeconds } from './audio.js';
import { synthesize, playOnConnection } from '../tools/voice.js';

/**
 * A live voice conversation in one guild.
 *
 * The bot joins a mapped voice channel, greets in its persona, then listens:
 * each time someone speaks, their audio is decoded, transcribed, answered by
 * the same chat() the text path uses, and spoken back. It stays connected
 * between utterances — unlike the speak_in_voice tool, which joins for a single
 * response and leaves.
 *
 * One session per guild, because a voice connection is per guild: Discord will
 * not let the bot occupy two channels in the same server.
 */

// Silence that ends an utterance. Long enough to survive a mid-sentence pause,
// short enough that the reply doesn't feel late. Discord measures this from the
// last received packet, so it is real silence rather than wall-clock.
const SILENCE_MS = parseInt(process.env.VOICE_SILENCE_MS || '1200', 10);

// Ignore utterances shorter than this. Coughs, keyboard noise, and the "mm" of
// someone thinking all produce sub-second bursts that cost an STT call and
// transcribe to nothing useful.
const MIN_UTTERANCE_SECONDS = parseFloat(process.env.VOICE_MIN_SECONDS || '0.6');

// Discord sends 48kHz stereo; the decoder must be told, or the PCM comes out
// at the wrong rate and the transcript is gibberish.
const DECODER_OPTS = { rate: 48000, channels: 2, frameSize: 960 };

/**
 * Tool packs a voice session loads, deliberately narrower than the project's.
 *
 * Every tool definition sits in the prefix that is resent on every utterance,
 * and the prefix is the dominant term in reply latency: a fresh session costs
 * roughly 23k tokens before anyone has spoken, against a spoken answer of a few
 * hundred. Text turns are occasional and can absorb that; voice generates a
 * full turn per utterance, and the cost is paid as dead air the speaker sits
 * through.
 *
 * files + web makes voice a talking-and-reading interface — he can read the
 * code and look things up, but committing and pushing stay on the text path,
 * where there is a transcript to review before anything lands in a repo.
 */
const VOICE_TOOL_PACKS = (process.env.VOICE_TOOL_PACKS || 'files,web')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Phrases that address the bot.
 *
 * Matched against a normalized transcript, so punctuation and capitalization
 * from the transcriber don't matter ("Hey, Buddy." and "hey buddy" are the same
 * string by the time they get here). The near-misses are included because STT
 * reliably mangles a short unstressed second word — "buddy" comes back as
 * "body" or "bud" often enough that omitting them would read as the wake word
 * being broken.
 */
const WAKE_PHRASES = (process.env.VOICE_WAKE_PHRASES ||
  'hey buddy,hi buddy,hey bud,hey body,hey buddie,ok buddy,okay buddy')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// After a reply, keep listening without the wake phrase for this long. A
// conversation is a back-and-forth; requiring "hey buddy" before every sentence
// makes it a series of commands instead.
const FOLLOW_UP_MS = parseInt(process.env.VOICE_FOLLOW_UP_MS || '30000', 10);

/**
 * Utterances before the conversation history is dropped.
 *
 * MAX_STORED_SESSIONS bounds how many channels stay resident but nothing bounds
 * the length of one conversation, so a long voice session grows without limit —
 * and unlike a text channel, voice appends a turn per utterance. Dropping the
 * history costs the thread's memory of what was said; keeping it costs latency
 * on every remaining turn, which is the thing being felt.
 */
const MAX_VOICE_TURNS = parseInt(process.env.VOICE_MAX_TURNS || '20', 10);

/** Lowercase, strip punctuation, collapse whitespace — for wake-phrase matching. */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Was the bot addressed?
 *
 * Checked against the opening of the utterance rather than anywhere in it, so
 * saying his name in passing mid-sentence doesn't summon him. The allowance is
 * generous enough to survive a transcriber that drops a leading word.
 */
function isAddressed(transcript) {
  const opening = normalize(transcript).slice(0, 40);
  return WAKE_PHRASES.some((phrase) => opening.includes(phrase));
}

/** guildId -> VoiceSession */
const sessions = new Map();

export class VoiceSession {
  constructor({ project, voiceChannel, chat, clearHistory }) {
    this.project = project;
    // The project as voice sees it: same id, repo, and prompt — only the tool
    // set narrows. id is unchanged deliberately, since handlers key per-project
    // state on it and a second id would look like a second project.
    this.voiceProject = { ...project, toolPacks: VOICE_TOOL_PACKS };
    this.voiceChannel = voiceChannel;
    this.chat = chat;
    this.clearHistory = clearHistory;
    this.connection = null;
    // Serializes turns: the bot must not transcribe its own reply, nor answer
    // two people at once with one connection to play audio on.
    this.busy = false;
    this.listening = new Set();
    this.closed = false;
    // Wall-clock until which speech is treated as directed at the bot without
    // the wake phrase. Zero means only a wake phrase will engage him.
    this.engagedUntil = 0;
    this.turns = 0;
  }

  get guildId() {
    return this.voiceChannel.guild.id;
  }

  /** Channel key for conversation history — the voice channel, so a voice chat
   * keeps its own thread rather than colliding with the text channel's. */
  get historyKey() {
    return `voice:${this.voiceChannel.id}`;
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // must be false or Discord sends us no audio at all
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      console.error(`[voice:${this.project.id}] Could not join: ${err.message}`);
      this.destroy();
      return false;
    }

    // Each join starts a fresh conversation. A voice call is an episode with a
    // beginning and an end, unlike a text channel that is picked up days later,
    // and resuming the last one is what made the prefix creep across rejoins.
    this.resetHistory('new session');

    console.log(
      `[voice:${this.project.id}] Joined "${this.voiceChannel.name}" — listening ` +
        `(wake: "${WAKE_PHRASES[0]}", tools: ${VOICE_TOOL_PACKS.join('+')}).`,
    );

    this.connection.receiver.speaking.on('start', (userId) => this.onSpeakingStart(userId));
    await this.greet();
    return true;
  }

  /** Drop the thread's history. Safe to call when no history exists yet. */
  resetHistory(reason) {
    this.turns = 0;
    try {
      this.clearHistory?.(this.historyKey);
    } catch (err) {
      // Losing the reset costs latency, not correctness — never the session.
      console.warn(`[voice:${this.project.id}] History reset failed: ${err.message}`);
      return;
    }
    console.log(`[voice:${this.project.id}] History reset (${reason}).`);
  }

  /**
   * Say hello in the project's own voice.
   *
   * Routed through chat() rather than a hardcoded string so the greeting comes
   * from the project's system prompt — the persona is the point.
   */
  async greet() {
    this.busy = true;
    try {
      const reply = await this.chat(
        this.voiceProject,
        this.historyKey,
        '[You just joined a voice channel. Greet whoever is here in one short ' +
          'sentence and ask what they want to work on. Speak naturally — this ' +
          'will be read aloud, so no markdown, lists, or code.]',
        [],
        'system',
      );
      await this.say(reply);
      // The greeting is an invitation, so the window opens without a wake
      // phrase — being asked a question and then ignored for answering it
      // would read as the bot being broken.
      this.engage();
    } catch (err) {
      console.error(`[voice:${this.project.id}] Greeting failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Capture one utterance from a user.
   *
   * Discord fires 'start' every time someone unmutes or resumes talking, so
   * this guards against subscribing twice to the same person — two decoders on
   * one stream would interleave PCM and produce garbage.
   */
  onSpeakingStart(userId) {
    if (this.closed || this.listening.has(userId)) return;
    if (this.busy) return; // mid-reply: don't capture our own audio or queue up
    this.listening.add(userId);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder(DECODER_OPTS);
    const chunks = [];

    decoder.on('data', (c) => chunks.push(c));
    opus.pipe(decoder);

    opus.once('end', async () => {
      this.listening.delete(userId);
      const pcm = Buffer.concat(chunks);
      const seconds = pcmDurationSeconds(pcm);
      if (seconds < MIN_UTTERANCE_SECONDS) return;
      await this.handleUtterance(userId, pcm, seconds);
    });

    opus.once('error', (err) => {
      this.listening.delete(userId);
      console.error(`[voice:${this.project.id}] Receive error: ${err.message}`);
    });
  }

  /** Open the follow-up window, measured from now. */
  engage() {
    this.engagedUntil = Date.now() + FOLLOW_UP_MS;
  }

  /**
   * Was this utterance meant for the bot?
   *
   * True if it opens with a wake phrase, or if it lands inside the window after
   * his last reply — a conversation is a back-and-forth, and requiring the name
   * before every sentence turns it into a series of commands. Outside both, the
   * room is talking amongst itself and he stays out of it.
   */
  isForMe(transcript) {
    if (isAddressed(transcript)) return true;
    return Date.now() < this.engagedUntil;
  }

  async handleUtterance(userId, pcm, seconds) {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const transcript = await transcribe(pcmToWav(pcm));
      if (!transcript) return;

      const member = this.voiceChannel.guild.members.cache.get(userId);
      const username = member?.displayName || member?.user?.username || 'Someone';
      console.log(
        `[voice:${this.project.id}] ${username} (${seconds.toFixed(1)}s): ${transcript}`,
      );

      // The gate sits after transcription because deciding whether the bot was
      // addressed needs words — so an ignored utterance still costs an STT
      // call. What it saves is the model turn and the speech, which are the
      // expensive parts and the ones that produce an unwanted interruption.
      if (!this.isForMe(transcript)) {
        console.log(`[voice:${this.project.id}] Not addressed — ignoring.`);
        return;
      }

      if (this.turns >= MAX_VOICE_TURNS) {
        this.resetHistory(`${MAX_VOICE_TURNS}-turn cap`);
      }
      this.turns += 1;

      const reply = await this.chat(
        this.voiceProject,
        this.historyKey,
        transcript +
          '\n\n[This came from voice. Answer in one or two spoken sentences — ' +
          'no markdown, lists, or code blocks, since it will be read aloud.]',
        [],
        username,
      );
      await this.say(reply);
      // Extended from the end of the reply rather than its start, so a slow
      // turn doesn't eat the window the speaker was given to respond in.
      this.engage();
    } catch (err) {
      console.error(`[voice:${this.project.id}] Turn failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Speak text on this session's existing connection. */
  async say(text) {
    if (!text || this.closed) return;
    // chat() appends a token-usage footer that is meaningless read aloud.
    const spoken = text.replace(/\n*-# ~[\d,]+ tokens this turn.*$/s, '').trim();
    if (!spoken) return;

    const audio = await synthesize(spoken);
    if (typeof audio === 'string') {
      console.warn(`[voice:${this.project.id}] TTS unavailable: ${audio}`);
      return;
    }
    await playOnConnection(this.connection, audio);
  }

  destroy() {
    this.closed = true;
    const conn = this.connection || getVoiceConnection(this.guildId);
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
      conn.destroy();
    }
    sessions.delete(this.guildId);
    console.log(`[voice:${this.project.id}] Left "${this.voiceChannel.name}".`);
  }
}

export function getSession(guildId) {
  return sessions.get(guildId);
}

export async function startSession({ project, voiceChannel, chat, clearHistory }) {
  if (sessions.has(voiceChannel.guild.id)) return sessions.get(voiceChannel.guild.id);
  const session = new VoiceSession({ project, voiceChannel, chat, clearHistory });
  sessions.set(voiceChannel.guild.id, session);
  const ok = await session.start();
  return ok ? session : null;
}

export function stopSession(guildId) {
  sessions.get(guildId)?.destroy();
}
