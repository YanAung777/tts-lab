/**
 * Builds a static, deployable copy of the lab UI.
 *
 * The interactive lab normally talks to a local Node server. This script
 * inlines a static voice catalog and the normalizer's output for the sample
 * texts, so the page still demonstrates the before/after comparison without
 * a backend.
 *
 * Run: node scripts/build-static.js
 */
import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from '../src/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const OUT = join(ROOT, 'dist');

await mkdir(OUT, { recursive: true });

// Copy static assets
for (const f of await readdir(join(ROOT, 'public'))) {
  await copyFile(join(ROOT, 'public', f), join(OUT, f));
}

// Ship the real normalizer to the browser. It has no Node-specific code, so
// the client uses the exact same implementation as the server instead of a
// hand-written approximation that can drift (and did: it mangled dates).
await copyFile(join(ROOT, 'src', 'normalize.js'), join(OUT, 'normalize.js'));

// Build the sample catalog the static page needs.
const SAMPLES = [
  {
    label: 'Business summary',
    voice: 'English_ConfidentWoman',
    raw: 'We closed 912 accounts last quarter, and the discrepancy rate dropped to 2.4%, which is below our target of 5%. Q3 revenue came in at $1,234.56 per account, up 18% YoY. Dr. Chen flagged that the Q3 figures are now final.',
  },
  {
    label: 'Abbreviation heavy',
    voice: 'English_Wiselady',
    raw: 'The FY24 report is due from Dept. Finance by EOD. Approx. 45% of the discrepancy was caused by missing SKU codes. Please see the appendix for details, or ping me at 555-123-4567 if you need help.',
  },
  {
    label: 'Narrator voice',
    voice: 'English_CaptivatingStoryteller',
    raw: 'Hi there. I wanted to walk you through the invoice reconciliation workflow. We closed nine hundred and twelve accounts last quarter, and the discrepancy rate dropped to two point four percent, which is comfortably below our target of five percent.',
  },
  {
    label: 'Phone + currency edge cases',
    voice: 'English_ConfidentWoman',
    raw: 'Ship the order by 3pm on 2026-10-21. The total was $2.5M, up 18% YoY, and the customer is at +1 555-123-4567.',
  },
];

const catalog = SAMPLES.map((s) => ({
  ...s,
  normalized: normalize(s.raw),
}));

await writeFile(join(OUT, 'samples.json'), JSON.stringify(catalog, null, 2));

// Copy the rendered before/after audio so the static page can play it.
const AUDIO_DIR = resolve(
  process.env.TTS_AUDIO_DIR || join(ROOT, '..', 'tts-audio-demo'),
);
await mkdir(join(OUT, 'audio'), { recursive: true });
const AUDIO_FILES = {
  'English_ConfidentWoman': { raw: 'business-raw.mp3', normalized: 'business-normalized.mp3' },
  'English_Wiselady': { raw: 'abbrev-raw.mp3', normalized: 'abbrev-normalized.mp3' },
  'English_CaptivatingStoryteller': { raw: 'narrator-raw.mp3', normalized: 'narrator-normalized.mp3' },
};
for (const s of catalog) {
  const pair = AUDIO_FILES[s.voice];
  if (!pair) continue;
  await copyFile(join(AUDIO_DIR, pair.raw), join(OUT, 'audio', pair.raw));
  await copyFile(join(AUDIO_DIR, pair.normalized), join(OUT, 'audio', pair.normalized));
  s.files = pair;
}
await writeFile(join(OUT, 'samples.json'), JSON.stringify(catalog, null, 2));

// Rewrite index.html to load the static app instead of the API-backed one.
let html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
html = html.replace(
  /<script type="module" src="\/app\.js"><\/script>/,
  '<script type="module" src="/static-app.js"></script>',
);
if (html.includes('/app.js')) {
  throw new Error('Failed to swap app.js for static-app.js in index.html');
}

// Point the page at a live backend when one is configured, so the deployed
// site does real server-side synthesis instead of the browser's voice.
// TTS_BACKEND_URL is optional — without it the page falls back to the
// browser speech engine and the pre-rendered samples.
const backendUrl = (process.env.TTS_BACKEND_URL || '').replace(/\/+$/, '');
if (backendUrl) {
  html = html.replace(
    '<head>',
    `<head>\n<script>globalThis.TTS_BACKEND_URL=${JSON.stringify(backendUrl)};</script>`,
  );
  console.log(`Static build will call the live backend at ${backendUrl}`);
} else {
  console.log('Static build has no backend configured (browser voice + pre-rendered samples)');
}
await writeFile(join(OUT, 'index.html'), html);

// The API-backed client is not needed in the static bundle.
await rm(join(OUT, 'app.js'), { force: true });

console.log(`Static build written to ${OUT}`);
console.log(`  ${catalog.length} samples pre-normalized`);
