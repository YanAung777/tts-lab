import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME)) launchOpts.executablePath = CHROME;

const BASE = process.env.BASE || 'http://127.0.0.1:4199';
const OUT = process.env.OUT || '/workspace/tts-lab/shots';

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

await page.screenshot({ path: `${OUT}/10-static.png`, fullPage: true });

// Exercise the compare flow
await page.click('#btnCompare');
await page.waitForTimeout(1200);
await page.locator('#comparePanel').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/11-static-compare.png`, fullPage: true });

// Verify the audio actually loads and can play
const audioOk = await page.evaluate(async () => {
  const results = [];
  for (const id of ['rawPlayer', 'normPlayer', 'player']) {
    const a = document.getElementById(id);
    if (!a?.src) { results.push({ id, ok: false, why: 'no src' }); continue; }
    a.load();
    const meta = await new Promise((res) => {
      if (a.readyState >= 1) return res(true);
      a.addEventListener('loadedmetadata', () => res(true), { once: true });
      a.addEventListener('error', () => res(false), { once: true });
      setTimeout(() => res(a.readyState >= 1), 10000);
    });
    results.push({ id, ok: meta, duration: a.duration, src: a.src.split('/').pop() });
  }
  return results;
});

// Mobile
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mpage = await mob.newPage();
await mpage.goto(BASE, { waitUntil: 'networkidle' });
await mpage.waitForTimeout(800);
await mpage.screenshot({ path: `${OUT}/12-static-mobile.png`, fullPage: true });

console.log('audio:', audioOk);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
