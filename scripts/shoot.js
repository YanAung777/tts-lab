import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:4177';
const OUT = process.env.OUT || '/workspace/tts-lab/shots';

// The sandbox ships full Chromium but not the headless-shell build, so we
// point Playwright at the real binary.
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME)) launchOpts.executablePath = CHROME;

const SAMPLE = 'We closed 912 accounts last quarter, and the discrepancy rate dropped to 2.4%, which is below our target of 5%. Q3 revenue came in at $1,234.56 per account, up 18% YoY. Dr. Chen flagged that the figures are now final.';

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#text', SAMPLE);
await page.waitForTimeout(700);

// Desktop
await page.screenshot({ path: `${OUT}/01-desktop.png`, fullPage: true });

// Mobile
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mpage = await mob.newPage();
await mpage.goto(BASE, { waitUntil: 'networkidle' });
await mpage.fill('#text', SAMPLE);
await mpage.waitForTimeout(600);
await mpage.screenshot({ path: `${OUT}/02-mobile.png`, fullPage: true });

// Synthesize and capture the preview state
await page.click('#btnSpeak');
await page.waitForFunction(() => !document.getElementById('playerWrap').classList.contains('hidden'), { timeout: 90000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/03-synthesized.png`, fullPage: true });

// Compare panel
await page.click('#btnCompare');
await page.waitForTimeout(1200);
await page.waitForFunction(() => document.querySelector('#normPlayer')?.src, { timeout: 90000 });
await page.waitForTimeout(800);
await page.locator('#comparePanel').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/04-compare.png`, fullPage: true });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
