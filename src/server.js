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

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/** Default copy for the shareable /demo page. */
const SAMPLE_DEMO_TEXT =
  'We closed 912 accounts last quarter, and the discrepancy rate dropped to 2.4%, '
  + 'which is below our target of 5%. Q3 revenue came in at $1,234.56 per account, up 18% YoY. '
  + 'Dr. Chen flagged that the Q3 figures are now final.';

/** The shareable /demo page. */
function demoPageHtml({ raw, spoken, audioId, synthError, voice, engine }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const player = audioId
    ? `<audio controls autoplay src="/api/audio/${audioId}"></audio>
       <p class="meta">${esc(voice)} · ${esc(engine)} · normalized text spoken</p>
       <p class="meta">audio url: /api/audio/${esc(audioId)}</p>`
    : `<p class="err">Synthesis failed: ${esc(synthError || 'unknown error')}</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTS Lab — live demo</title>
<style>
  body{margin:0;padding:40px 22px 60px;background:#0b0f14;color:#e6edf5;
    font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px;letter-spacing:-.02em}
  p.sub{color:#7c8a9c;margin:0 0 28px;font-size:14px}
  a{color:#4ade9b}
  .card{background:#121821;border:1px solid #1e2836;border-radius:14px;padding:18px;margin-bottom:16px}
  .tag{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#7c8a9c;margin-bottom:10px;
    display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  .dot.raw{background:#ff8a8a}.dot.norm{background:#4ade9b}
  p.txt{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:13px;line-height:1.7;
    margin:0 0 4px;white-space:pre-wrap;word-break:break-word}
  .raw .txt{color:#b9c6d6}
  .norm .txt{color:#b9e8d0}
  audio{width:100%;margin-top:14px}
  .meta{color:#7c8a9c;font-size:12.5px;margin:8px 0 0;font-family:'JetBrains Mono',monospace}
  .err{color:#ff8a8a;font-size:13px}
  form{margin-top:8px}
  textarea{width:100%;min-height:96px;padding:12px 14px;border-radius:10px;border:1px solid #1e2836;
    background:#0a0e14;color:#e6edf5;font-family:inherit;font-size:14px;resize:vertical}
  button{margin-top:11px;padding:9px 18px;border-radius:9px;border:1px solid #4ade9b;background:#4ade9b;
    color:#06210f;font-weight:600;font-size:13.5px;cursor:pointer}
  .links{margin-top:22px;font-size:13px;color:#7c8a9c;display:flex;gap:14px;flex-wrap:wrap}
</style></head>
<body><div class="wrap">
  <h1>TTS Lab — live demo</h1>
  <p class="sub">Text normalized and spoken server-side · engine <strong>${esc(engine)}</strong></p>

  <div class="card norm">
    <div class="tag"><span class="dot norm"></span> What the model receives (normalized)</div>
    <p class="txt">${esc(spoken)}</p>
    ${player}
  </div>

  <div class="card raw">
    <div class="tag"><span class="dot raw"></span> Your original text</div>
    <p class="txt">${esc(raw)}</p>
  </div>

  <div class="card">
    <div class="tag">Try your own text</div>
    <form method="get" action="/demo">
      <textarea name="text" placeholder="Type anything with numbers, currency, dates or abbreviations…">${esc(raw)}</textarea>
      <button type="submit">Normalize &amp; speak</button>
    </form>
  </div>

  <div class="links">
    <a href="/">Open the full lab UI →</a>
    <a href="/api">API reference →</a>
    <a href="/api/health">Health →</a>
  </div>
</div></body></html>`;
}

/** Human-readable API index for `/api`. */
function apiIndexHtml() {
  const rows = [
    ['GET', '/api/health', 'Server + engine status'],
    ['GET', '/api/voices?engine=matrix', 'Available voices'],
    ['GET', '/api/normalize?text=...', 'Preview text normalization'],
    ['POST', '/api/speak', 'Synthesize — returns audio bytes'],
    ['POST', '/api/stream', 'Synthesize — returns SSE progress + audio URL'],
  ];
  const items = rows
    .map(([m, p, d]) => `<tr><td><code>${m}</code></td><td><code>${p}</code></td><td>${d}</td></tr>`)
    .join('\n        ');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTS Lab API</title>
<style>
  body{margin:0;padding:40px 22px;background:#0b0f14;color:#e6edf5;
    font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}
  p.sub{color:#7c8a9c;margin:0 0 26px;font-size:14px}
  table{width:100%;border-collapse:collapse;background:#121821;border:1px solid #1e2836;
    border-radius:12px;overflow:hidden}
  td,th{padding:11px 14px;text-align:left;border-bottom:1px solid #1e2836;font-size:13.5px}
  tr:last-child td{border-bottom:none}
  code{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:12.5px;color:#4ade9b}
  .m{color:#7c8a9c;font-weight:600;font-size:11px;letter-spacing:.05em}
  a{color:#4ade9b}
  .box{margin-top:22px;padding:16px 18px;background:#121821;border:1px solid #1e2836;border-radius:12px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#7c8a9c;margin:0 0 10px}
  textarea{width:100%;min-height:88px;padding:11px 13px;border-radius:9px;border:1px solid #1e2836;
    background:#0a0e14;color:#e6edf5;font-family:inherit;font-size:14px;resize:vertical}
  button{margin-top:11px;padding:9px 18px;border-radius:9px;border:1px solid #4ade9b;background:#4ade9b;
    color:#06210f;font-weight:600;font-size:13.5px;cursor:pointer}
  .out{margin-top:12px;padding:12px 14px;border-radius:9px;background:#0a0e14;border:1px solid #1e2836;
    font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:12.5px;color:#b9e8d0;
    white-space:pre-wrap;word-break:break-word;min-height:40px}
  audio{width:100%;margin-top:12px}
</style></head>
<body><div class="wrap">
  <h1>TTS Lab API</h1>
  <p class="sub">Live backend · engine: <strong>${config.engine}</strong> · <a href="/">open the lab UI →</a></p>
  <table>
    <tr><th>Method</th><th>Path</th><th>What it does</th></tr>
        ${items}
  </table>
  <div class="box">
    <h2>Try it — normalize + speak</h2>
    <textarea id="t">We closed 912 accounts at $1,234.56, up 2.4% YoY. Dr. Chen flagged Q3 on 2026-10-21.</textarea>
    <button id="go">Normalize &amp; speak</button>
    <div class="out" id="out">Press the button…</div>
    <audio id="au" controls></audio>
  </div>
</div>
<script>
document.getElementById('go').addEventListener('click', async () => {
  const text = document.getElementById('t').value;
  const out = document.getElementById('out');
  const au = document.getElementById('au');
  out.textContent = 'working…';
  try {
    const n = await (await fetch('/api/normalize?text=' + encodeURIComponent(text))).json();
    out.textContent = n.output;
    const r = await fetch('/api/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: n.output, engine: '${config.engine}' }),
    });
    if (!r.ok) throw new Error('speak failed: ' + r.status);
    au.src = URL.createObjectURL(await r.blob());
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
});
</script>
</body></html>`;
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
  const startedAt = Date.now();

  // Log every request once it completes — makes the server usable as a
  // live demo (you can see calls landing from the tunnel).
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    console.log(`${res.statusCode} ${req.method} ${path} ${ms}ms`);
  });

  // CORS: the deployed static UI is served from a different origin than this
  // backend, so the browser needs explicit permission to call it.
  //
  // The origin is echoed back rather than hard-coded, and a Vary header is
  // set so caches don't serve one origin's response to another. There is no
  // cookie or credential auth on this API, so allowing any origin does not
  // expose an authenticated session to a third party.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

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

    // ---- GET /api/demo.html ----------------------------------------------
    // A human-readable API index. Hitting the API URLs in a browser shows
    // raw JSON, which is unfriendly when the server is shared as a demo.
    if (req.method === 'GET' && path === '/api') {
      return sendHtml(res, 200, apiIndexHtml());
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

    // ---- GET /api/speak -------------------------------------------------
    // GET form: ?text=...&voice=...&normalize=1
    // Returns the same audio bytes as POST, so the endpoint can be opened
    // directly in a browser or a media player.
    if (req.method === 'GET' && path === '/api/speak') {
      const text = url.searchParams.get('text') || '';
      if (!text.trim()) return sendJson(res, 400, { error: 'text is required' });
      const shouldNormalize = url.searchParams.get('normalize') !== '0';
      const spoken = shouldNormalize ? normalize(text) : text;
      const voice = url.searchParams.get('voice') || undefined;
      const engine = url.searchParams.get('engine') || config.engine;
      const result = await synthesize({ ...buildEngineOptions({ text: spoken, voice, engine }) });
      res.writeHead(200, {
        'Content-Type': result.mimeType || 'audio/mpeg',
        'Content-Length': result.audio.length,
        'X-TTS-Engine': result.engine,
        'X-TTS-Voice': result.voice,
        'Cache-Control': 'no-store',
      });
      return res.end(result.audio);
    }

    // ---- GET /demo -------------------------------------------------------
    // A shareable, self-contained page: the text is normalized and spoken
    // server-side, and the rendered page shows both versions with a player.
    if (req.method === 'GET' && path === '/demo') {
      const text = url.searchParams.get('text') || SAMPLE_DEMO_TEXT;
      const voice = url.searchParams.get('voice') || undefined;
      const spoken = normalize(text);

      let audioId = null;
      let synthError = null;
      try {
        const result = await synthesize({
          ...buildEngineOptions({ text: spoken, voice, engine: config.engine }),
        });
        audioId = randomUUID();
        outputs.set(audioId, {
          audio: result.audio,
          mimeType: result.mimeType,
          voice: result.voice,
          engine: result.engine,
          createdAt: Date.now(),
        });
      } catch (err) {
        synthError = err.message;
      }

      return sendHtml(res, 200, demoPageHtml({
        raw: text,
        spoken,
        audioId,
        synthError,
        voice: voice || '(engine default)',
        engine: config.engine,
      }));
    }

    // ---- POST /api/speak -------------------------------------------------
    if (req.method === 'POST' && path === '/api/speak') {
      const body = await readBody(req);
      if (!body.text || !String(body.text).trim()) {
        return sendJson(res, 400, { error: 'text is required' });
      }
      const opts = buildEngineOptions(body);

      let result;
      try {
        result = await synthesize(opts);
      } catch (err) {
        // The upstream TTS service is intermittently flaky. Say so plainly
        // and use 503 (retryable) rather than an opaque 500.
        const transient = /invalid signature|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i
          .test(err.message);
        console.error(`speak failed (${transient ? 'transient' : 'error'}): ${err.message}`);
        return sendJson(res, transient ? 503 : 500, {
          error: transient
            ? 'The TTS service is temporarily unavailable. Please retry in a moment.'
            : `Synthesis failed: ${err.message}`,
          retryable: transient,
        });
      }

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
