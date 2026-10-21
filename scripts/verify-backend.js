import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME)) launchOpts.executablePath = CHROME;

const BASE = process.env.BASE || 'https://b0eb57a7cf82c4.lhr.life';
const OUT = process.env.OUT || '/workspace/tts-lab/shots';

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const failed = [];
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

// The sandbox can't reach the tunnel host over its own egress, so drive the
// browser against it and let Chromium do the routing.
let loaded = false;
for (let attempt = 1; attempt <= 5 && !loaded; attempt += 1) {
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('#btnSpeak', { timeout: 20000 });
    loaded = true;
    console.log(`loaded on attempt ${attempt}`);
  } catch (err) {
    console.log(`attempt ${attempt}: ${err.message.split('\n')[0]}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}
if (!loaded) {
  console.log('LIVE VERIFICATION FAILED');
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(2000);

// --- 1. Live synthesis through the public tunnel -----------------------
await page.fill('#text', 'We closed 912 accounts at $1,234.56, up 2.4% YoY. Dr. Chen flagged Q3 on 2026-10-21.');
await page.waitForTimeout(800);

const norm = (await page.textContent('#normalized')).trim();
console.log('normalized:', norm.slice(0, 160));

await page.click('#btnSpeak');
// Wait for the audio player to actually receive decodable audio.
await page.waitForFunction(() => {
  const a = document.getElementById('player');
  return a && a.src && a.readyState >= 1;
}, { timeout: 120000 });
await page.waitForTimeout(600);

const synth = await page.evaluate(() => {
  const a = document.getElementById('player');
  return { src: a.src.slice(0, 90), duration: a.duration, readyState: a.readyState };
});
console.log('synthesized:', synth);

await page.screenshot({ path: `${OUT}/30-live-backend.png`, fullPage: true });

// --- 2. The API index's "Normalize & speak" box ------------------------
await page.goto(`${BASE}/api`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#go', { timeout: 20000 });
await page.waitForTimeout(800);
await page.click('#go');
await page.waitForFunction(() => {
  const a = document.getElementById('au');
  return a && a.src && a.readyState >= 1;
}, { timeout: 120000 });
const apiBox = await page.evaluate(() => ({
  out: document.getElementById('out').textContent.trim().slice(0, 160),
  duration: document.getElementById('au').duration,
}));
console.log('api box:', apiBox);
await page.screenshot({ path: `${OUT}/31-live-api.png`, fullPage: true });

// --- 3. CORS preflight from a foreign origin ---------------------------
const cors = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/api/health`, { headers: { Origin: 'https://example.com' } });
  return { status: r.status, allowOrigin: r.headers.get('access-control-allow-origin') };
}, BASE);
console.log('cors:', cors);

console.log('page errors:', errors.length ? errors : 'none');
console.log('failed responses:', failed.length ? failed : 'none');
await browser.close();
