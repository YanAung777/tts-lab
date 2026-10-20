/**
 * End-to-end smoke test: exercises the real server over HTTP.
 * Run: node scripts/smoke.js
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.SMOKE_PORT || 4199;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;

function check(cond, label, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${extra}`);
  }
}

const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), TTS_ENGINE: 'matrix' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

// If the port is already taken, fail fast with a clear message instead of
// a stack trace.
let spawnFailed = null;
server.on('error', (err) => { spawnFailed = err; });

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    if (spawnFailed) {
      if (spawnFailed.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other server or set SMOKE_PORT.`);
      } else {
        console.error(`Server failed to start: ${spawnFailed.message}`);
      }
      return false;
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

try {
  const up = await waitForServer();
  if (!up) {
    console.error('Server never came up:\n', serverLog);
    process.exit(1);
  }

  // --- health ---
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.ok === true, 'health responds');
  check(health.engine === 'matrix', 'engine is matrix', JSON.stringify(health));

  // --- normalize ---
  const norm = await (await fetch(`${BASE}/api/normalize?text=${encodeURIComponent('We closed 912 accounts at $1,234.56, up 2.4%.')} `)).json();
  check(norm.output.includes('nine hundred and twelve'), 'normalize expands cardinals', norm.output);
  check(norm.output.includes('one thousand two hundred and thirty-four dollars'), 'normalize expands currency', norm.output);
  check(norm.output.includes('two point four percent'), 'normalize expands percent', norm.output);
  check(Array.isArray(norm.sentences) && norm.sentences.length > 0, 'normalize splits sentences');

  // --- voices ---
  const voices = await (await fetch(`${BASE}/api/voices?engine=matrix`)).json();
  check(voices.total > 100, 'voice list is large', `total=${voices.total}`);
  check(Array.isArray(voices.voices), 'voices is an array');

  // The "matrix" engine is the sandbox's TTS connector, which is only
  // present in this environment. On CI (or anywhere without it) the
  // synthesis-dependent checks are skipped rather than failed — the
  // normalizer and API surface are what CI can meaningfully verify.
  const hasMatrix = voices.total > 0;

  // --- speak ---
  const speakRes = await fetch(`${BASE}/api/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello there, this is a smoke test.', engine: 'matrix', voice: 'English_ConfidentWoman' }),
  });

  if (hasMatrix) {
    check(speakRes.ok, 'speak returns 200', String(speakRes.status));
    const audio = Buffer.from(await speakRes.arrayBuffer());
    check(audio.length > 1000, 'speak returns audio bytes', `len=${audio.length}`);
    check(speakRes.headers.get('x-tts-engine') === 'matrix', 'engine header set');
    check(!!speakRes.headers.get('x-tts-voice'), 'voice header set');
  } else {
    check(speakRes.status >= 500, 'speak without an engine fails cleanly', String(speakRes.status));
    console.log('  skip synthesis checks (no TTS engine available in this environment)');
  }

  // --- stream ---
  const streamRes = await fetch(`${BASE}/api/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Streaming test, one two three.', engine: 'matrix', voice: 'English_Wiselady' }),
  });

  if (hasMatrix) {
    check(streamRes.ok, 'stream returns 200', String(streamRes.status));
    const sse = await streamRes.text();
    check(sse.includes('event: normalized'), 'stream emits normalized event');
    check(sse.includes('event: done'), 'stream emits done event');

    const idMatch = sse.match(/"id":"([\w-]+)"/);
    check(!!idMatch, 'stream returns an id');
    if (idMatch) {
      const audioRes = await fetch(`${BASE}/api/audio/${idMatch[1]}`);
      check(audioRes.ok, 'streamed audio is retrievable', String(audioRes.status));
      const a2 = Buffer.from(await audioRes.arrayBuffer());
      check(a2.length > 1000, 'streamed audio has bytes', `len=${a2.length}`);
    }
  } else {
    check(streamRes.status >= 500, 'stream without an engine fails cleanly', String(streamRes.status));
  }

  // --- 404 handling ---
  const missing = await fetch(`${BASE}/api/audio/does-not-exist`);
  check(missing.status === 404, 'unknown audio id returns 404', String(missing.status));

  // --- bad input ---
  const bad = await fetch(`${BASE}/api/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  });
  check(bad.status === 400, 'empty text returns 400', String(bad.status));

  // --- static UI ---
  const ui = await fetch(`${BASE}/`);
  check(ui.ok, 'UI serves', String(ui.status));
  const uiText = await ui.text();
  check(uiText.includes('TTS'), 'UI renders');
  const css = await fetch(`${BASE}/style.css`);
  check(css.ok, 'stylesheet serves');
  const js = await fetch(`${BASE}/app.js`);
  check(js.ok, 'client script serves');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error('Smoke test crashed:', err);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await sleep(300);
}
