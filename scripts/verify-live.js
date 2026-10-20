import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME)) launchOpts.executablePath = CHROME;

const BASE = process.env.BASE || 'https://amq3ucip7dlit.space.minimax.io';
const OUT = process.env.OUT || '/workspace/tts-lab/shots';

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const failed = [];
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

// Retry the initial navigation — sandbox egress to this host is flaky.
let loaded = false;
for (let attempt = 1; attempt <= 6 && !loaded; attempt += 1) {
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
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

await page.waitForTimeout(2500);

// Type custom text and confirm the live normalizer handles it
await page.fill('#text', 'We closed 912 accounts at $1,234.56, up 2.4% YoY. Dr. Chen flagged Q3 on 2026-10-21.');
await page.waitForTimeout(900);
const preview = await page.textContent('#normalized');
console.log('live preview:', preview.trim().slice(0, 150));

// Confirm all three buttons are wired
const btns = await page.evaluate(() => ({
  speak: !!document.getElementById('btnSpeak'),
  ab: !!document.getElementById('btnAB'),
  compare: !!document.getElementById('btnCompare'),
  speechApi: 'speechSynthesis' in window,
}));

await page.screenshot({ path: `${OUT}/20-live.png`, fullPage: true });

// Sample-voice compare flow
await page.click('#btnCompare');
await page.waitForTimeout(2500);
await page.locator('#comparePanel').scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/21-live-compare.png`, fullPage: true });

const audio = await page.evaluate(async () => {
  const out = [];
  for (const id of ['rawPlayer', 'normPlayer']) {
    const a = document.getElementById(id);
    if (!a?.src) { out.push({ id, ok: false, why: 'no src' }); continue; }
    a.load();
    const ok = await new Promise((res) => {
      if (a.readyState >= 1) return res(true);
      a.addEventListener('loadedmetadata', () => res(true), { once: true });
      a.addEventListener('error', () => res(false), { once: true });
      setTimeout(() => res(a.readyState >= 1), 20000);
    });
    out.push({ id, ok, duration: a.duration, file: a.src.split('/').pop() });
  }
  return out;
});

console.log('buttons:', btns);
console.log('audio:', audio);
console.log('page errors:', errors.length ? errors : 'none');
console.log('failed responses:', failed.length ? failed : 'none');
await browser.close();
