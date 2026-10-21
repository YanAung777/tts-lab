/**
 * TTS engines.
 *
 * Three providers, one interface:
 *   - nvidiaHosted  Magpie TTS on build.nvidia.com (hosted NIM, needs API key)
 *   - nvidiaLocal   Magpie TTS NIM container on your own GPU box
 *   - matrix        the connector-backed TTS available in this sandbox
 *
 * Every provider returns { audio, mimeType, voice, engine } and throws on
 * failure. Callers should not care which one is active.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** NVIDIA Build hosted endpoint for magpie-tts-multilingual. */
export const NVIDIA_HOSTED_TTS_URL =
  'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com';

/**
 * Built-in Magpie voices. Voice names follow
 * Model.LOCALE.Speaker[.Emotion] — use /v1/audio/list_voices to get the live
 * list from your own deployment.
 */
export const MAGPIE_VOICES = {
  'en-US': [
    'Magpie-Multilingual.EN-US.Aria',
    'Magpie-Multilingual.EN-US.Jason',
    'Magpie-Multilingual.EN-US.Leo',
    'Magpie-Multilingual.EN-US.Sofia',
    'Magpie-Multilingual.EN-US.Aria.Neutral',
    'Magpie-Multilingual.EN-US.Aria.Calm',
    'Magpie-Multilingual.EN-US.Aria.Angry',
    'Magpie-Multilingual.EN-US.Aria.Sad',
    'Magpie-Multilingual.EN-US.Jason.Neutral',
    'Magpie-Multilingual.EN-US.Jason.Happy',
    'Magpie-Multilingual.EN-US.Jason.Angry',
    'Magpie-Multilingual.EN-US.Jason.Sad',
    'Magpie-Multilingual.EN-US.Sofia.Neutral',
    'Magpie-Multilingual.EN-US.Sofia.Calm',
    'Magpie-Multilingual.EN-US.Sofia.Happy',
  ],
  'es-US': ['Magpie-Multilingual.ES-US.Natalia', 'Magpie-Multilingual.ES-US.Luis'],
  'fr-FR': ['Magpie-Multilingual.FR-FR.Louise', 'Magpie-Multilingual.FR-FR.Henri'],
  'de-DE': ['Magpie-Multilingual.DE-DE.Jana', 'Magpie-Multilingual.DE-DE.Klaus'],
  'zh-CN': ['Magpie-Multilingual.ZH-CN.Siwei', 'Magpie-Multilingual.ZH-CN.Ren'],
  'ja-JP': ['Magpie-Multilingual.JA-JP.Siwei'],
  'hi-IN': ['Magpie-Multilingual.HI-IN.Ananya'],
  'ko-KR': ['Magpie-Multilingual.KO-KR.Gook'],
  'vi-VN': ['Magpie-Multilingual.VI-NN.Han'],
  'ar-XA': ['Magpie-Multilingual.AR-XA.Nadim'],
  'pt-BR': ['Magpie-Multilingual.PT-BR.Jessica'],
  'it-IT': ['Magpie-Multilingual.IT-IT.Roberta'],
};

/** Map a 2-letter code to the locale Magpie expects. */
export function toLocale(lang) {
  if (!lang) return 'en-US';
  const known = Object.keys(MAGPIE_VOICES);
  if (known.includes(lang)) return lang;
  const base = lang.split(/[-_]/)[0].toLowerCase();
  const match = known.find((l) => l.split('-')[0].toLowerCase() === base);
  return match || 'en-US';
}

/**
 * Parse the OpenAI-ish /v1/audio/speech style response body.
 * Magpie's HTTP API returns raw audio bytes; the streaming endpoint returns
 * headerless LPCM which the caller must wrap in a WAV container.
 */
export function parseAudioResponse(buffer, contentType, { raw = false, sampleRate = 22050 } = {}) {
  const isWav = buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF';
  if (isWav) {
    return { audio: buffer, mimeType: 'audio/wav', headerless: false };
  }
  if (raw) {
    return { audio: buffer, mimeType: 'audio/L16; rate=22050', headerless: true, sampleRate };
  }
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('wav')) return { audio: buffer, mimeType: 'audio/wav', headerless: false };
  if (ct.includes('mpeg') || ct.includes('mp3')) return { audio: buffer, mimeType: 'audio/mpeg', headerless: false };
  if (ct.includes('ogg')) return { audio: buffer, mimeType: 'audio/ogg', headerless: false };
  if (ct.includes('flac')) return { audio: buffer, mimeType: 'audio/flac', headerless: false };
  if (ct.includes('pcm') || ct.includes('l16')) return { audio: buffer, mimeType: 'audio/L16', headerless: true, sampleRate };
  // Unknown content type: assume the container is a WAV and let the client sniff.
  return { audio: buffer, mimeType: ct || 'audio/wav', headerless: false };
}

/**
 * Wrap headerless LPCM in a 44-byte WAV header so browsers can play it.
 */
export function pcmToWav(pcmBuffer, { sampleRate = 22050, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Provider: NVIDIA hosted NIM on build.nvidia.com.
 * Requires NVIDIA_API_KEY (free tier available).
 */
export async function nvidiaHosted({
  text,
  voice = 'Magpie-Multilingual.EN-US.Aria',
  language = 'en-US',
  apiKey,
  sampleRate = 22050,
  streaming = false,
  timeoutMs = 60000,
} = {}) {
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY is required for the hosted NVIDIA TTS endpoint');
  }

  const locale = toLocale(language);
  const endpoint = streaming
    ? `${NVIDIA_HOSTED_TTS_URL}/v1/audio/synthesize_online`
    : `${NVIDIA_HOSTED_TTS_URL}/v1/audio/synthesize`;

  const form = new FormData();
  form.append('text', text);
  form.append('language', locale);
  form.append('voice', voice);
  form.append('sample_rate_hz', String(sampleRate));
  if (!streaming) form.append('encoding', 'LINEAR_PCM');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`NVIDIA TTS ${res.status}: ${detail.slice(0, 400)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = parseAudioResponse(buf, res.headers.get('content-type'), {
      raw: streaming,
      sampleRate,
    });

    if (parsed.headerless) {
      return { ...parsed, audio: pcmToWav(parsed.audio, { sampleRate }), mimeType: 'audio/wav', headerless: false };
    }
    return { ...parsed, voice, engine: 'nvidia-hosted', locale };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider: NVIDIA TTS NIM running on your own GPU.
 * Expects the container's HTTP port (default 9000).
 */
export async function nvidiaLocal({
  text,
  voice = 'Magpie-Multilingual.EN-US.Aria',
  language = 'en-US',
  baseUrl = 'http://localhost:9000',
  sampleRate = 22050,
  streaming = false,
  timeoutMs = 60000,
} = {}) {
  const locale = toLocale(language);
  const endpoint = streaming
    ? `${baseUrl}/v1/audio/synthesize_online`
    : `${baseUrl}/v1/audio/synthesize`;

  const form = new FormData();
  form.append('text', text);
  form.append('language', locale);
  form.append('voice', voice);
  form.append('sample_rate_hz', String(sampleRate));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`NVIDIA TTS NIM ${res.status}: ${detail.slice(0, 400)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = parseAudioResponse(buf, res.headers.get('content-type'), {
      raw: streaming,
      sampleRate,
    });
    if (parsed.headerless) {
      return { ...parsed, audio: pcmToWav(parsed.audio, { sampleRate }), mimeType: 'audio/wav', headerless: false };
    }
    return { ...parsed, voice, engine: 'nvidia-local', locale };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry a command.
 *
 * The connector CLI intermittently fails with a transient "invalid signature"
 * error (roughly 1 call in 3 during load). A live server should ride that
 * out rather than return a 500 to the caller, so we retry with exponential
 * backoff plus jitter.
 */
const TRANSIENT_RE = /invalid signature|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network/i;

async function execWithRetry(cmd, args, { timeout, attempts = 5, retryDelayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await execFileAsync(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      lastErr = err;
      const text = `${err.message} ${err.stderr || ''}`;
      if (!TRANSIENT_RE.test(text) || i === attempts - 1) throw err;
      // Exponential backoff with jitter, so concurrent requests don't
      // retry in lockstep.
      const wait = retryDelayMs * 2 ** i + Math.floor(Math.random() * 800);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Provider: the connector-backed Matrix TTS available in this environment.
 * 332 voices, emotion/pitch/speed control, returns an MP3.
 */
export async function matrixTts({
  text,
  voiceId = 'English_ConfidentWoman',
  emotion,
  speed = 1.0,
  pitch = 0,
  volume,
  timeoutMs = 120000,
} = {}) {
  const args = { text, voice_id: voiceId };
  if (emotion) args.emotion = emotion;
  if (speed !== undefined) args.speed = speed;
  if (pitch !== undefined) args.pitch = pitch;
  if (volume !== undefined) args.volume = volume;

  const { stdout } = await execWithRetry(
    'mcode-tools',
    ['connector', 'call', 'connector__matrix__synthesize_speech', '--args', JSON.stringify(args)],
    { timeout: timeoutMs },
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Matrix TTS returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (parsed.code !== 0 || !parsed.node_id) {
    throw new Error(`Matrix TTS failed: ${parsed.message || 'unknown error'}`);
  }

  const { stdout: urlOut } = await execWithRetry(
    'mcode-tools',
    ['get_asset_url', parsed.node_id],
    { timeout: 60000 },
  );
  const { download_url: downloadUrl } = JSON.parse(urlOut);

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Matrix TTS asset download failed: ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());

  return {
    audio,
    mimeType: 'audio/mpeg',
    headerless: false,
    voice: voiceId,
    engine: 'matrix',
    nodeId: parsed.node_id,
  };
}

/** List the Matrix voices available in this environment. */
export async function listMatrixVoices() {
  const { stdout } = await execFileAsync(
    'mcode-tools',
    ['connector', 'call', 'connector__matrix__get_voice_list', '--args', '{}'],
    { timeout: 60000 },
  );
  return JSON.parse(stdout);
}

/**
 * Dispatch to the configured provider.
 */
export async function synthesize({ engine = 'auto', ...opts } = {}) {
  const chosen = engine === 'auto' ? (opts.apiKey ? 'nvidia-hosted' : 'matrix') : engine;

  switch (chosen) {
    case 'nvidia-hosted':
      return nvidiaHosted(opts);
    case 'nvidia-local':
      return nvidiaLocal(opts);
    case 'matrix':
      return matrixTts(opts);
    default:
      throw new Error(`Unknown engine: ${chosen}`);
  }
}

export default { synthesize, nvidiaHosted, nvidiaLocal, matrixTts, listMatrixVoices, MAGPIE_VOICES, toLocale };
