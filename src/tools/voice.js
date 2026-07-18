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

// The voice channel the current message author is in (set by the message handler)
let _voiceChannel = null;

export function setVoiceChannel(channel) {
  _voiceChannel = channel;
}

/**
 * Convert text to speech via ElevenLabs and play it in the user's voice channel.
 * Joins automatically, speaks, then disconnects.
 */
export async function speakInVoice(text) {
  if (!_voiceChannel) {
    return 'The user is not in a voice channel right now — cannot speak.';
  }

  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return 'ElevenLabs is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.';
  }

  // ElevenLabs free tier: 10k chars/month — truncate very long responses
  const truncated = text.length > 4500
    ? text.slice(0, 4500) + ' ... (truncated for voice)'
    : text;

  // Strip markdown that sounds weird when spoken
  const spoken = truncated
    .replace(/```[\s\S]*?```/g, '(code block)') // replace code blocks
    .replace(/`([^`]+)`/g, '$1')                 // inline code → plain text
    .replace(/\*\*(.+?)\*\*/g, '$1')             // bold
    .replace(/\*(.+?)\*/g, '$1')                 // italic
    .replace(/#{1,6}\s/g, '')                    // headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // links → link text only
    .trim();

  // Call ElevenLabs TTS
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
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown error');
    return `ElevenLabs error (${res.status}): ${errText}`;
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  console.log(`[voice] Got ${audioBuffer.length} bytes of audio`);

  // Get or create voice connection
  const guildId = _voiceChannel.guild.id;
  let connection = getVoiceConnection(guildId);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = joinVoiceChannel({
      channelId: _voiceChannel.id,
      guildId,
      adapterCreator: _voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    return `Failed to connect to voice channel: ${err.message}`;
  }

  // Play the MP3 audio (ffmpeg transcodes it to Opus for Discord)
  const readable  = Readable.from(audioBuffer);
  const resource  = createAudioResource(readable, { inputType: StreamType.Arbitrary });
  const player    = createAudioPlayer();

  connection.subscribe(player);
  player.play(resource);

  // Wait for playback to finish (or timeout after 3 minutes)
  await new Promise(resolve => {
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once('error', err => {
      console.error('[voice] Player error:', err.message);
      resolve();
    });
    setTimeout(resolve, 180_000);
  });

  connection.destroy();
  return `Spoke in voice channel "${_voiceChannel.name}" and disconnected.`;
}

/**
 * Leave the voice channel immediately (useful if the bot gets stuck).
 */
export function leaveVoice() {
  if (!_voiceChannel) return 'Not tracking a voice channel.';
  const connection = getVoiceConnection(_voiceChannel.guild.id);
  if (connection) {
    connection.destroy();
    return `Left voice channel "${_voiceChannel.name}".`;
  }
  return 'Not currently in a voice channel.';
}
