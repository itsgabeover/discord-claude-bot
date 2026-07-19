import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  getVoiceConnection,
} from '@discordjs/voice';
import { Readable } from 'stream';

/**
 * The voice channel each project's most recent message author was in.
 *
 * Scoped per project rather than kept in one variable, because one variable is
 * shared by every server the bot serves. A turn is long and asynchronous — a
 * chain of tool calls — so a message arriving in another server partway through
 * would overwrite it, and speak_in_voice would then join *that* server's voice
 * channel: it reads guild.id off this value to open the connection. Keying by
 * project means the game server can never redirect audio meant for Wublets.
 *
 * project.id is the finest granularity available here. Both backends hand tool
 * handlers `(input, project)` and nothing narrower, and the SDK path's MCP
 * server is built once per project and cached, so its handlers close over the
 * project alone. Two turns running concurrently *within one project* can still
 * overwrite each other; that window is far smaller than the cross-server one,
 * and closing it would mean threading per-turn context through both backends.
 *
 * @type {Map<string, object|null>}
 */
const voiceChannels = new Map();

/**
 * Record where this project's current author is speaking from.
 *
 * Called by the message handler for every message, including with null when the
 * author isn't in voice — which is what clears a stale channel from a previous
 * message rather than leaving the bot ready to talk into an empty room.
 */
export function setVoiceChannel(projectId, channel) {
  voiceChannels.set(projectId, channel ?? null);
}

function voiceChannelFor(project) {
  return voiceChannels.get(project?.id) ?? null;
}

/**
 * Strip markdown that sounds wrong read aloud, and cap length.
 *
 * Shared by the tool and the live voice session so both speak the same way —
 * a code fence read character by character is unlistenable either way.
 */
export function forSpeech(text) {
  const truncated = text.length > 4500
    ? text.slice(0, 4500) + ' ... (truncated for voice)'
    : text;

  return truncated
    .replace(/```[\s\S]*?```/g, '(code block)') // replace code blocks
    .replace(/`([^`]+)`/g, '$1')                 // inline code → plain text
    .replace(/\*\*(.+?)\*\*/g, '$1')             // bold
    .replace(/\*(.+?)\*/g, '$1')                 // italic
    .replace(/#{1,6}\s/g, '')                    // headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // links → link text only
    .trim();
}

/**
 * Turn text into speech audio. Returns a Buffer, or a string on failure.
 *
 * Split out from speakInVoice so the live voice session can synthesize without
 * inheriting the tool's join-speak-disconnect lifecycle — a conversation needs
 * the connection to stay open between utterances.
 */
export async function synthesize(text) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';

  if (!apiKey || !voiceId) {
    return 'ElevenLabs is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.';
  }

  const spoken = forSpeech(text);
  console.log(`[voice] Requesting TTS for ${spoken.length} chars`);

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: spoken,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown error');
    return `ElevenLabs error (${res.status}): ${errText}`;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[voice] Got ${buf.length} bytes of audio`);
  return buf;
}

/**
 * Play an audio buffer on an existing connection and resolve when it finishes.
 *
 * Leaves the connection open — callers decide whether to disconnect. The
 * three-minute ceiling is a backstop against a player that never reports Idle,
 * which would otherwise hang the turn forever.
 */
export async function playOnConnection(connection, audioBuffer) {
  const resource = createAudioResource(Readable.from(audioBuffer), {
    inputType: StreamType.Arbitrary,
  });
  const player = createAudioPlayer();

  connection.subscribe(player);
  player.play(resource);

  await new Promise(resolve => {
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once('error', err => {
      console.error('[voice] Player error:', err.message);
      resolve();
    });
    setTimeout(resolve, 180_000);
  });
}

/**
 * Convert text to speech via ElevenLabs and play it in the user's voice channel.
 * Joins automatically, speaks, then disconnects.
 */
export async function speakInVoice(text, project) {
  const voiceChannel = voiceChannelFor(project);
  if (!voiceChannel) {
    return 'The user is not in a voice channel right now — cannot speak.';
  }

  const audio = await synthesize(text);
  if (typeof audio === 'string') return audio; // configuration or API error

  const guildId = voiceChannel.guild.id;
  let connection = getVoiceConnection(guildId);
  const joinedHere = !connection || connection.state.status === VoiceConnectionStatus.Destroyed;

  if (joinedHere) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    if (joinedHere) connection.destroy();
    return `Failed to connect to voice channel: ${err.message}`;
  }

  await playOnConnection(connection, audio);

  // Only tear down a connection this call opened. A live voice conversation
  // owns its own connection and must survive the bot answering a question
  // that happened to arrive by text.
  if (joinedHere) {
    connection.destroy();
    return `Spoke in voice channel "${voiceChannel.name}" and disconnected.`;
  }
  return `Spoke in voice channel "${voiceChannel.name}".`;
}

/**
 * Leave the voice channel immediately (useful if the bot gets stuck).
 */
export function leaveVoice(project) {
  const voiceChannel = voiceChannelFor(project);
  if (!voiceChannel) return 'Not tracking a voice channel.';
  const connection = getVoiceConnection(voiceChannel.guild.id);
  if (connection) {
    connection.destroy();
    return `Left voice channel "${voiceChannel.name}".`;
  }
  return 'Not currently in a voice channel.';
}
