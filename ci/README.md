# CI workflow

`ci.yml` is the GitHub Actions workflow for this repo. It runs the normalizer
unit tests and the end-to-end smoke tests on Node 18, 20 and 22.

## Enabling it (one manual step)

The file lives here rather than in `.github/workflows/` because the API token
used to publish this repo doesn't carry GitHub's `workflow` scope, so writes
to `.github/workflows/` were rejected. GitHub only reads workflows from that
exact directory.

To activate:

1. In the GitHub web UI, go to **.github/workflows/**
2. Click **Add file → Create new file**
3. Set the filename to `ci.yml` and paste the contents of `ci/ci.yml`
4. Commit directly to `main`

Or, from a local clone:

```bash
mkdir -p .github/workflows
cp ci/ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "Enable CI"
git push
```

Once the file is in `.github/workflows/`, every push and PR runs the tests
automatically. The badge will appear in the repo header.

## What it runs

| Step | Command | Needs |
|---|---|---|
| Unit tests | `node src/normalize.test.js` | nothing |
| End-to-end | `node scripts/smoke.js` | a TTS engine |

The smoke test starts its own server on port 4199 and exercises the HTTP API.
Synthesis-dependent assertions are skipped automatically when no TTS engine is
reachable, so CI passes on a plain runner with no API key. To run the
synthesis path in CI, add an `NVIDIA_API_KEY` secret and set
`TTS_ENGINE=nvidia-hosted`.
