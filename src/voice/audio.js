/**
 * Audio helpers for voice conversation: PCM framing and speech-to-text.
 *
 * Discord hands us raw PCM once the Opus stream is decoded — 48kHz, 16-bit,
 * stereo. ElevenLabs wants a file, so we wrap that PCM in a WAV container
 * rather than re-encoding: a WAV header is 44 bytes of metadata in front of the
 * samples we already have, which costs nothing and avoids pulling in a codec.
 */

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

/**
 * Wrap raw PCM in a WAV container.
 *
 * The header is fixed-layout: a RIFF chunk, a format chunk describing the
 * sample shape, and a data chunk whose length must match the payload. Getting a
 * length wrong produces a file that decoders accept but read as silence or
 * static, so both are derived from the buffer rather than assumed.
 *
 * @param {Buffer} pcm - Raw little-endian 16-bit PCM
 * @returns {Buffer} A playable/uploadable WAV file
 */
export function pcmToWav(pcm) {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4); // file size minus the first 8 bytes
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size for PCM
  header.writeUInt16LE(1, 20); // format 1 = uncompressed PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** How many seconds of audio a PCM buffer represents. */
export function pcmDurationSeconds(pcm) {
  return pcm.length / ((SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8);
}

/**
 * Transcribe speech with ElevenLabs.
 *
 * Same key as the TTS side, so voice in and voice out share one provider and
 * one bill. Anthropic's own low-latency voice cookbook uses this model for the
 * same reason; measured round trip there is roughly half a second.
 *
 * Returns null rather than throwing on failure — a garbled or unbilled request
 * should leave the conversation running, not tear down the voice session.
 *
 * @param {Buffer} wav - WAV audio from pcmToWav()
 * @returns {Promise<string|null>} Transcript, or null if it couldn't be had
 */
export async function transcribe(wav) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.warn('[stt] ELEVENLABS_API_KEY is not set — cannot transcribe.');
    return null;
  }

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[stt] ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const text = (data.text || '').trim();
    return text || null;
  } catch (err) {
    console.error('[stt] Transcription failed:', err.message);
    return null;
  }
}
