import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const opts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME)) opts.executablePath = CHROME;
const SITE = process.env.SITE || 'https://69dkv3dcf2tkn.space.minimax.io';
const b = await chromium.launch(opts);
const ctx = await b.newContext({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
const failed = [];
p.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

let loaded = false;
for (let i = 1; i <= 5 && !loaded; i++) {
  try {
    await p.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await p.waitForSelector('#btnSpeak', { timeout: 20000 });
    loaded = true; console.log('loaded attempt', i);
  } catch (e) { console.log('attempt', i, e.message.split('\n')[0]); await new Promise(r=>setTimeout(r,4000)); }
}
if (!loaded) { console.log('FAILED to load'); await b.close(); process.exit(1); }

await p.waitForTimeout(1500);
console.log('backend cfg:', await p.evaluate(() => globalThis.TTS_BACKEND_URL));

await p.fill('#text', 'We closed 912 accounts at $1,234.56, up 2.4% YoY. Dr. Chen flagged Q3 on 2026-10-21.');
await p.waitForTimeout(700);
console.log('normalized:', (await p.textContent('#normalized')).trim().slice(0,140));

// Click "Speak my text" -> should hit the live backend
await p.click('#btnSpeak');
await p.waitForFunction(() => {
  const a = document.getElementById('player');
  return a && a.src && a.readyState >= 1;
}, { timeout: 200000 });
const res = await p.evaluate(() => {
  const a = document.getElementById('player');
  return { duration: a.duration, meta: document.getElementById('playerMeta').textContent, status: document.getElementById('status').textContent };
});
console.log('LIVE SYNTH:', res);
await p.screenshot({ path: '/workspace/tts-lab/shots/32-full-stack.png', fullPage: true });

console.log('page errors:', errs.length ? errs : 'none');
console.log('failed responses:', failed.length ? failed : 'none');
await b.close();
