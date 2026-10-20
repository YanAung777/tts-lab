# TTS Lab

Natural-sounding text-to-speech with NVIDIA's open speech stack.

The short version: **most "robotic TTS" is not the model, it's the text.**
A neural TTS model reads the literal characters you hand it. Give it
`"closed 912 accounts at $1,234.56, up 2.4% YoY"` and it faithfully says
*"nine hundred twelve accounts at dollar one two three four point five six,
up two point four percent, Y O Y"* — because that's what you asked for.

This project has two parts:

1. **A text normalization layer** (`src/normalize.js`) that rewrites text into
   spoken form before synthesis. This is the single biggest lever on naturalness.
2. **A lab app** (server + web UI) that lets you A/B voices and hear the
   before/after difference on your own copy.

---

## Quick start

```bash
git clone https://github.com/YanAung777/tts-lab.git
cd tts-lab
npm start           # http://localhost:4173
```

No dependencies to install — it's raw `node:http`. Node 18+.

```bash
npm test            # 56 normalizer unit tests
npm run smoke       # 24 end-to-end HTTP tests
```

Copy `.env.example` to `.env` to configure an engine. Never commit a real key.

**Live demo:** <https://84t4n9p7eevus.space.minimax.io> (static build, no backend
required — plays pre-rendered before/after audio and normalizes text in-browser)

**CI:** the Actions workflow is in [`ci/ci.yml`](ci/ci.yml) and needs one manual
move into `.github/workflows/` to activate — see [`ci/README.md`](ci/README.md)
for why and how.

---

## The models

Your reel (slide 03, "NVIDIA · voice model") is **PersonaPlex-7B** — NVIDIA's
full-duplex speech-to-speech model. It listens and speaks at once, handles
interruptions, and takes a **voice prompt** (audio) plus a **text prompt**
(role) so the same model can be a bank teller or a Mars-mission engineer.

That is a great model, but it is the **wrong shape** for a one-way TTS app:

| | PersonaPlex-7B | Magpie TTS |
|---|---|---|
| Input | audio (live mic) | text |
| Output | audio | audio |
| Needs a GPU | yes (A100/H100) | NIM container, or hosted API |
| Languages | English only | 12 |
| Role/persona control | yes (text + voice prompt) | n/a |
| Good for | voice agents, receptionists | narration, read-aloud, app TTS |

If your app renders text to speech, **Magpie TTS** is the model you want.
PersonaPlex is what you'd reach for if you're building a *conversation*.

### Magpie TTS facts

- 357M parameters, open weights
- 12 languages: en, es, fr, de, zh, vi, it, hi, ja, ko, ar, pt
- Time to first audio: **32–47 ms** single stream (H100/B200)
- Streaming and offline modes
- **NVIDIA Open Model License** — commercial use allowed, no attribution required
- Voice cloning via the `magpie-tts-zeroshot` NIM (3–10 s reference clip)

---

## Getting the NVIDIA engine running

### Option A — hosted API (fastest, no GPU)

1. Get a free key: <https://build.nvidia.com/nvidia/magpie-tts-multilingual>
2. Point the server at it:

```bash
export NVIDIA_API_KEY=nvapi-...
export TTS_ENGINE=nvidia-hosted
npm start
```

The lab's engine dropdown switches between providers at runtime, so you can
compare the hosted Magpie against the sandbox engine without a redeploy.

### Option B — self-hosted NIM container

```bash
export NGC_API_KEY=...
docker run -it --rm --name=magpie-tts \
  --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
  -e NGC_API_KEY=$NGC_API_KEY \
  -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 -p 50051:50051 \
  nvcr.io/nim/nvidia/magpie-tts-multilingual:latest

export TTS_ENGINE=nvidia-local
export NVIDIA_TTS_URL=http://localhost:9000
npm start
```

### Option C — open weights

Weights are on Hugging Face at `nvidia/magpie_tts_multilingual_357m`, runnable
through NeMo. Note the July 2026 release (v2607) **removed zero-shot voice
cloning** from the open checkpoint for security reasons — cloning is only
available via the `magpie-tts-zeroshot` NIM.

---

## API

### `POST /api/speak`

```jsonc
{
  "text": "We closed 912 accounts.",
  "engine": "nvidia-hosted",     // or "nvidia-local" | "matrix"
  "language": "en-US",
  "voice": "Magpie-Multilingual.EN-US.Aria",
  "sampleRate": 22050
}
```

Returns audio bytes. Response headers carry the resolved voice and engine, plus
`X-TTS-Normalized` (URL-encoded) so you can see exactly what the model got.

### `POST /api/stream`

Same body; returns Server-Sent Events: `normalized` → `status` → `done`
(with a retrievable audio URL) or `error`.

### `GET /api/normalize?text=...`

Preview the normalization without synthesizing. Returns `{ input, output, sentences }`.

### `GET /api/voices?engine=...` · `GET /api/health`

---

## Using the normalizer in your own app

It has no dependencies. Copy `src/normalize.js` and call it before you send
text to any TTS engine:

```js
import { normalize } from './src/normalize.js';

const spoken = normalize('We closed 912 accounts at $1,234.56, up 2.4% YoY.');
// "We closed nine hundred and twelve accounts at one thousand two hundred and
//  thirty-four dollars and fifty-six cents, up two point four percent year
//  over year."
```

Options:

```js
normalize(text, {
  expandContractions: true,   // "it's" -> "it is"
  expandAbbreviations: true,  // "Dr." -> "Doctor", "Q3" -> "third quarter"
  expandNumbers: true,        // numbers, currency, dates, times, units
  spokenPunctuation: true,
});
```

---

## What the normalizer handles

| Input | Output |
|---|---|
| `912` | nine hundred and twelve |
| `2.4%` | two point four percent |
| `$1,234.56` | one thousand two hundred and thirty-four dollars and fifty-six cents |
| `$2.5M` | two and a half million dollars |
| `₹1,50,000` | one lakh fifty thousand rupees |
| `2026-10-21` | October twenty-first, two thousand twenty-six |
| `09:30` / `11:59pm` | nine thirty / eleven fifty-nine p m |
| `555-123-4567` | 555 123 4567 (digits stay digits) |
| `21st` | twenty-first |
| `1999` | nineteen ninety-nine |
| `FY24` | fiscal year two thousand twenty-four |
| `Q3` / `YoY` | third quarter / year over year |
| `0.04s` | zero point zero four seconds |
| `2.5M` | two and a half million |
| `Dr. Chen` | Doctor Chen |

### What it deliberately leaves alone

- **Identifiers** — `SKU-9921`, `A1-B2`, `RFC-2616` stay as-is. Reading a SKU
  as "nine thousand nine hundred and twenty-one" is worse than useless.
- **URLs and emails** — `https://example.com/docs/2026` isn't prose.
- **Phone digits** — "five five five" is harder to follow than "555".
- **Acronyms that aren't markers** — `q3` stays lowercase; `Q3` expands.
- **Bare words** — no rewriting of ordinary vocabulary.

---

## Architecture

```
tts-lab/
├── src/
│   ├── normalize.js        # text → spoken form (no deps)
│   ├── normalize.test.js   # 56 unit tests
│   ├── engines.js          # provider adapters: nvidia-hosted | nvidia-local | matrix
│   └── server.js           # HTTP + SSE API and static host
├── public/                 # web UI
├── scripts/
│   ├── smoke.js            # end-to-end tests against a live server
│   ├── demo.js             # renders the before/after audio comparison
│   ├── build-static.js     # builds the deployable static bundle
│   └── shoot*.js           # UI screenshots
├── .github/workflows/ci.yml
├── .env.example
└── package.json
```

All three providers implement the same interface and return
`{ audio, mimeType, voice, engine }`, so swapping engines is a one-line
config change.

---

## Notes on the sandbox build

This was developed in a sandbox with **no GPU, no NVIDIA API key, and blocked
egress to `*.nvcf.nvidia.com`**. So:

- The normalizer, server, UI and tests are fully verified here (56 + 24 tests).
- The audio samples were rendered with the sandbox's own TTS connector, which
  has the same *shape* as Magpie (text in, expressive audio out) but is a
  different model. They're proof of the normalization delta, not of Magpie's
  specific timbre.
- The NVIDIA code paths (`nvidiaHosted`, `nvidiaLocal`) are written against
  the documented NIM HTTP contract — `POST /v1/audio/synthesize` with
  `multipart/form-data` fields `text`, `language`, `voice`, `sample_rate_hz`,
  `encoding`, and `GET /v1/audio/list_voices` — and could not be executed
  end-to-end from here. **Run the smoke test against a real key before
  trusting the NVIDIA path in production.**
- The streaming endpoint returns headerless LPCM; `pcmToWav()` in `engines.js`
  wraps it in a proper WAV container so browsers can play it.

---

## License

MIT for this code. NVIDIA model weights are under the
[NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license).
