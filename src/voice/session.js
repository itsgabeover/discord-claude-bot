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

/** guildId -> VoiceSession */
const sessions = new Map();

export class VoiceSession {
  constructor({ project, voiceChannel, chat }) {
    this.project = project;
    this.voiceChannel = voiceChannel;
    this.chat = chat;
    this.connection = null;
    // Serializes turns: the bot must not transcribe its own reply, nor answer
    // two people at once with one connection to play audio on.
    this.busy = false;
    this.listening = new Set();
    this.closed = false;
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

    console.log(
      `[voice:${this.project.id}] Joined "${this.voiceChannel.name}" — listening.`,
    );

    this.connection.receiver.speaking.on('start', (userId) => this.onSpeakingStart(userId));
    await this.greet();
    return true;
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
        this.project,
        this.historyKey,
        '[You just joined a voice channel. Greet whoever is here in one short ' +
          'sentence and ask what they want to work on. Speak naturally — this ' +
          'will be read aloud, so no markdown, lists, or code.]',
        [],
        'system',
      );
      await this.say(reply);
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

      const reply = await this.chat(
        this.project,
        this.historyKey,
        transcript +
          '\n\n[This came from voice. Answer in one or two spoken sentences — ' +
          'no markdown, lists, or code blocks, since it will be read aloud.]',
        [],
        username,
      );
      await this.say(reply);
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

export async function startSession({ project, voiceChannel, chat }) {
  if (sessions.has(voiceChannel.guild.id)) return sessions.get(voiceChannel.guild.id);
  const session = new VoiceSession({ project, voiceChannel, chat });
  sessions.set(voiceChannel.guild.id, session);
  const ok = await session.start();
  return ok ? session : null;
}

export function stopSession(guildId) {
  sessions.get(guildId)?.destroy();
}
