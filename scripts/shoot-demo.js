import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';
const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME)) launchOpts.executablePath = CHROME;

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1180, height: 1400 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('file:///workspace/tts-audio-demo/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: '/workspace/tts-audio-demo/comparison.png', fullPage: true });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
