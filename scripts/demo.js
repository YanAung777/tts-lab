/**
 * Generates the A/B audio demo: raw text vs normalized text.
 * Run: node scripts/demo.js
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { normalize } from '../src/normalize.js';

const execFileAsync = promisify(execFile);

// Output goes to ../tts-audio-demo by default; override with TTS_AUDIO_OUT.
const OUT = resolve(process.env.TTS_AUDIO_OUT || join(process.cwd(), '..', 'tts-audio-demo'));

const CASES = [
  {
    name: 'business',
    label: 'Business summary',
    voice: 'English_ConfidentWoman',
    raw: 'We closed 912 accounts last quarter, and the discrepancy rate dropped to 2.4%, which is below our target of 5%. Q3 revenue came in at $1,234.56 per account, up 18% YoY. Dr. Chen flagged that the Q3 figures are now final.',
  },
  {
    name: 'narrator',
    label: 'Narrator voice',
    voice: 'English_CaptivatingStoryteller',
    raw: 'Hi there. I wanted to walk you through the invoice reconciliation workflow. We closed nine hundred and twelve accounts last quarter, and the discrepancy rate dropped to two point four percent, which is comfortably below our target of five percent.',
  },
  {
    name: 'abbrev',
    label: 'Abbreviation heavy',
    voice: 'English_Wiselady',
    raw: 'The FY24 report is due from Dept. Finance by EOD. Approx. 45% of the discrepancy was caused by missing SKU codes. Please see the appendix for details, or ping me at 555-123-4567 if you need help.',
  },
];

async function synth(text, voice, outName) {
  const { stdout } = await execFileAsync(
    'mcode-tools',
    ['connector', 'call', 'connector__matrix__synthesize_speech', '--args',
      JSON.stringify({ text, voice_id: voice, output_file: outName })],
    { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  if (parsed.code !== 0) throw new Error(parsed.message || 'synthesis failed');
  const { stdout: urlOut } = await execFileAsync('mcode-tools', ['get_asset_url', parsed.node_id], { timeout: 60000 });
  const { download_url: url } = JSON.parse(urlOut);
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(join(OUT, outName), buf);
  return buf.length;
}

await mkdir(OUT, { recursive: true });

const manifest = [];
for (const c of CASES) {
  const spoken = normalize(c.raw);
  console.log(`\n=== ${c.label} (${c.voice}) ===`);
  console.log('RAW :', c.raw);
  console.log('TTS :', spoken);

  const rawFile = `${c.name}-raw.mp3`;
  const normFile = `${c.name}-normalized.mp3`;

  const rawSize = await synth(c.raw, c.voice, rawFile);
  const normSize = await synth(spoken, c.voice, normFile);

  manifest.push({
    case: c.name,
    label: c.label,
    voice: c.voice,
    raw: { file: rawFile, bytes: rawSize, text: c.raw },
    normalized: { file: normFile, bytes: normSize, text: spoken },
  });
  console.log(`  wrote ${rawFile} (${rawSize}B) and ${normFile} (${normSize}B)`);
}

await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('\nManifest written to manifest.json');
