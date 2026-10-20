/**
 * TTS Lab server.
 *
 * Endpoints:
 *   GET  /api/voices          list available voices for the active engine
 *   POST /api/speak           synthesize (returns audio bytes)
 *   POST /api/stream          synthesize with SSE progress + final audio URL
 *   GET  /api/health          engine status
 *   GET  /api/normalize       preview text normalization without synthesizing
 *   GET  /                   the web UI
 *
 * No dependencies — raw node:http. Keeps the thing runnable anywhere.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { normalize, splitSentences } from './normalize.js';
import {
  synthesize, listMatrixVoices, MAGPIE_VOICES, toLocale, NVIDIA_HOSTED_TTS_URL,
} from './engines.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4173);

const config = {
  engine: process.env.TTS_ENGINE || (process.env.NVIDIA_API_KEY ? 'nvidia-hosted' : 'matrix'),
  apiKey: process.env.NVIDIA_API_KEY || '',
  localBaseUrl: process.env.NVIDIA_TTS_URL || 'http://localhost:9000',
  defaultVoice: process.env.TTS_VOICE || '',
  defaultLanguage: process.env.TTS_LANGUAGE || 'en-US',
};

// In-memory store for streamed results so the client can fetch the audio.
const outputs = new Map();
const OUTPUT_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - OUTPUT_TTL_MS;
  for (const [id, rec] of outputs) {
    if (rec.createdAt < cutoff) outputs.delete(id);
  }
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

/**
 * Resolve the voice for the active engine.
 * The Matrix engine uses flat names like "English_ConfidentWoman"; NVIDIA
 * Magpie uses "Magpie-Multilingual.EN-US.Aria".
 */
function resolveVoice(engine, requested, language) {
  if (requested) return requested;
  if (engine === 'nvidia-hosted' || engine === 'nvidia-local') {
    const locale = toLocale(language);
    const list = MAGPIE_VOICES[locale] || MAGPIE_VOICES['en-US'];
    return list[0];
  }
  return config.defaultVoice || 'English_ConfidentWoman';
}

function buildEngineOptions(body) {
  const engine = body.engine || config.engine;
  const language = body.language || config.defaultLanguage;
  const voice = resolveVoice(engine, body.voice, language);

  const base = {
    text: body.text,
    language,
    voice,
  };

  if (engine === 'nvidia-hosted') {
    return { ...base, engine, apiKey: body.apiKey || config.apiKey, streaming: !!body.streaming };
  }
  if (engine === 'nvidia-local') {
    return { ...base, engine, baseUrl: body.baseUrl || config.localBaseUrl, streaming: !!body.streaming };
  }
  return {
    ...base,
    engine,
    voiceId: voice,
    emotion: body.emotion,
    speed: body.speed ?? 1.0,
    pitch: body.pitch ?? 0,
    volume: body.volume,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    // ---- GET /api/health -------------------------------------------------
    if (req.method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        engine: config.engine,
        engineSource: config.engine === 'auto' ? 'auto' : 'config',
        hasApiKey: !!config.apiKey,
        hostedEndpoint: NVIDIA_HOSTED_TTS_URL,
        localEndpoint: config.localBaseUrl,
        defaultLanguage: config.defaultLanguage,
      });
    }

    // ---- GET /api/voices -------------------------------------------------
    if (req.method === 'GET' && path === '/api/voices') {
      const engine = url.searchParams.get('engine') || config.engine;
      if (engine === 'matrix') {
        try {
          const result = await listMatrixVoices();
          return sendJson(res, 200, {
            engine: 'matrix',
            voices: (result.available_voices || []).map((v) => ({
              id: v.voice_id,
              name: v.voice_name,
              group: v.voice_id.split('_')[0].replace(/\s*\([^)]*\)\s*$/, ''),
            })),
            total: result.total,
          });
        } catch (err) {
          return sendJson(res, 502, { error: `Could not list Matrix voices: ${err.message}` });
        }
      }
      return sendJson(res, 200, {
        engine,
        voices: Object.entries(MAGPIE_VOICES).flatMap(([locale, list]) =>
          list.map((id) => ({ id, name: id.split('.').slice(2).join('.'), group: locale })),
        ),
      });
    }

    // ---- GET /api/normalize ----------------------------------------------
    if (req.method === 'GET' && path === '/api/normalize') {
      const text = url.searchParams.get('text') || '';
      const out = normalize(text);
      return sendJson(res, 200, { input: text, output: out, sentences: splitSentences(out) });
    }

    // ---- POST /api/speak -------------------------------------------------
    if (req.method === 'POST' && path === '/api/speak') {
      const body = await readBody(req);
      if (!body.text || !String(body.text).trim()) {
        return sendJson(res, 400, { error: 'text is required' });
      }
      const opts = buildEngineOptions(body);
      const result = await synthesize(opts);

      res.writeHead(200, {
        'Content-Type': result.mimeType || 'audio/wav',
        'Content-Length': result.audio.length,
        'X-TTS-Engine': result.engine || opts.engine,
        'X-TTS-Voice': result.voice || opts.voice,
        'X-TTS-Normalized': encodeURIComponent(normalize(body.text)),
        'Cache-Control': 'no-store',
      });
      return res.end(result.audio);
    }

    // ---- POST /api/stream ------------------------------------------------
    if (req.method === 'POST' && path === '/api/stream') {
      const body = await readBody(req);
      if (!body.text || !String(body.text).trim()) {
        return sendJson(res, 400, { error: 'text is required' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const normalized = normalize(body.text);
        const sentences = splitSentences(normalized);
        send('normalized', { text: normalized, sentences });

        const opts = buildEngineOptions(body);
        send('status', { stage: 'synthesizing', engine: opts.engine, voice: opts.voice });

        const result = await synthesize(opts);

        const id = randomUUID();
        outputs.set(id, {
          audio: result.audio,
          mimeType: result.mimeType,
          voice: result.voice,
          engine: result.engine,
          createdAt: Date.now(),
        });

        send('done', {
          id,
          url: `/api/audio/${id}`,
          mimeType: result.mimeType,
          voice: result.voice,
          engine: result.engine,
          bytes: result.audio.length,
          sentences: sentences.length,
        });
      } catch (err) {
        send('error', { message: err.message });
      }
      return res.end();
    }

    // ---- GET /api/audio/:id ---------------------------------------------
    const audioMatch = path.match(/^\/api\/audio\/([\w-]+)$/);
    if (req.method === 'GET' && audioMatch) {
      const rec = outputs.get(audioMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Audio not found or expired' });
      res.writeHead(200, {
        'Content-Type': rec.mimeType || 'audio/wav',
        'Content-Length': rec.audio.length,
        'Cache-Control': 'no-store',
      });
      return res.end(rec.audio);
    }

    // ---- Static ----------------------------------------------------------
    if (req.method === 'GET') {
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const full = resolve(PUBLIC_DIR, rel);

      // Containment check: the resolved path must stay inside PUBLIC_DIR.
      const relPath = relative(PUBLIC_DIR, full);
      if (relPath.startsWith('..') || relPath.startsWith(sep) || resolve(full) !== full) {
        return sendJson(res, 403, { error: 'Forbidden' });
      }

      try {
        const data = await readFile(full);
        res.writeHead(200, {
          'Content-Type': MIME[extname(full)] || 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (err) {
    if (res.headersSent) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`); } catch {}
      return res.end();
    }
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`TTS Lab listening on http://localhost:${PORT}`);
  console.log(`  engine: ${config.engine}`);
  console.log(`  hosted: ${NVIDIA_HOSTED_TTS_URL}`);
  console.log(`  local:  ${config.localBaseUrl}`);
});

export default server;
