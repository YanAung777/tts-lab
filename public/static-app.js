/**
 * The real normalizer, shared verbatim with the server.
 *
 * src/normalize.js has no Node-specific code, so the static build ships it
 * as-is. One implementation, 56 unit tests, no client/server drift.
 */
import { normalize as normalizeText } from '/normalize.js';

/* TTS Lab — static (backend-free) build.
 * Shows the normalization pipeline live in the browser and links to the
 * rendered before/after audio samples. */

const $ = (id) => document.getElementById(id);

const el = {
  engine: $('engine'),
  language: $('language'),
  voice: $('voice'),
  text: $('text'),
  speed: $('speed'),
  pitch: $('pitch'),
  emotion: $('emotion'),
  normalize: $('normalize'),
  speak: $('btnSpeak'),
  ab: $('btnAB'),
  compare: $('btnCompare'),
  sample: $('btnSample'),
  reset: $('btnReset'),
  status: $('status'),
  player: $('player'),
  playerWrap: $('playerWrap'),
  playerVoice: $('playerVoice'),
  playerMeta: $('playerMeta'),
  emptyState: $('emptyState'),
  engineLabel: $('engineLabel'),
  engineBadge: $('engineBadge'),
  normalized: $('normalized'),
  comparePanel: $('comparePanel'),
  closeCompare: $('btnCloseCompare'),
  rawText: $('rawText'),
  normText: $('normText'),
  rawPlayer: $('rawPlayer'),
  normPlayer: $('normPlayer'),
  rawMeta: $('rawMeta'),
  normMeta: $('normMeta'),
};

let samples = [];
let activeSample = null;

const SPEED_VAL = $('speedVal');
const PITCH_VAL = $('pitchVal');

/* ---------------- helpers ---------------- */

function setStatus(msg, kind = '') {
  el.status.textContent = msg;
  el.status.className = `status ${kind}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Word-level diff so the preview shows what actually changed. */
function highlightDiff(before, after) {
  const bSet = new Set(before.split(/(\s+)/).filter((w) => w.trim()));
  const aWords = after.split(/(\s+)/);
  const aSet = new Set(aWords.filter((w) => w.trim()));
  const html = aWords
    .map((w) => {
      if (!w.trim()) return w;
      if (!bSet.has(w)) return `<span class="changed">${escapeHtml(w)}</span>`;
      return escapeHtml(w);
    })
    .join('');
  return { html, added: [...aSet].filter((w) => !bSet.has(w)).length };
}

/* ---------------- data ---------------- */

async function loadSamples() {
  try {
    const res = await fetch('/samples.json');
    samples = await res.json();
  } catch {
    samples = [];
  }
  const voices = [...new Set(samples.map((s) => s.voice))];
  el.voice.innerHTML = voices.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');  el.engineLabel.textContent = 'static preview';
  el.engineBadge.textContent = 'offline demo';
  el.engineBadge.className = 'badge warn';
  // No backend in the static build — swap the engine selector for a note.
  el.engine.innerHTML = '<option>Offline demo (no backend)</option>';
  el.engine.disabled = true;
  el.language.disabled = true;
  el.speak.textContent = 'Play normalized';
}

function updatePreview() {
  const text = el.text.value;
  if (!text.trim()) {
    el.normalized.innerHTML = '<span class="muted sm">Type something above…</span>';
    return;
  }
  const out = normalizeText(text);
  if (el.normalize.checked) {
    const { html, added } = highlightDiff(text, out);
    el.normalized.innerHTML = html;
    el.normalized.title = `${added} token(s) rewritten for speech`;
  } else {
    el.normalized.textContent = text;
  }
}

/* ---------------- audio ---------------- */

const AUDIO_BASE = '/audio';

/**
 * Browser-native speech synthesis, used to read arbitrary text the user
 * types. This is the sandbox stand-in for a live TTS engine: it won't sound
 * like Magpie, but it proves the pipeline — the normalized text goes in and
 * the browser speaks it.
 */
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const hasSpeech = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

function availableVoices() {
  if (!hasSpeech) return [];
  return synth.getVoices();
}

function pickVoice() {
  const voices = availableVoices();
  if (!voices.length) return null;
  // Prefer a natural-sounding English voice when the browser exposes one.
  const preferred = [
    'Google UK English Female', 'Google US English', 'Microsoft Aria',
    'Microsoft Jenny', 'Samantha', 'Daniel', 'Karen', 'Moira',
  ];
  for (const name of preferred) {
    const hit = voices.find((v) => v.name === name);
    if (hit) return hit;
  }
  return voices.find((v) => v.lang?.startsWith('en')) || voices[0];
}

function speak(text, { rate = 1, pitch = 1 } = {}) {
  if (!hasSpeech) {
    setStatus('This browser has no speech synthesis available.', 'error');
    return false;
  }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = rate;
  u.pitch = pitch;
  u.lang = v?.lang || 'en-US';
  synth.speak(u);
  return true;
}

function pickSample() {
  const s = samples.find((x) => x.voice === el.voice.value) || samples[0];
  return s;
}

function playSample(kind) {
  const s = activeSample || pickSample();
  if (!s) {
    setStatus('No audio samples loaded.', 'error');
    return;
  }
  const file = s.files?.[kind];
  if (!file) {
    setStatus('No audio for this sample.', 'error');
    return;
  }
  const player = kind === 'raw' ? el.rawPlayer : el.normPlayer;
  player.src = `${AUDIO_BASE}/${file}`;
  player.play().catch(() => {});
}

/** Point both players at the current sample without auto-playing. */
function loadSampleAudio() {
  const s = activeSample || pickSample();
  if (!s?.files) return;
  el.rawPlayer.src = `${AUDIO_BASE}/${s.files.raw}`;
  el.normPlayer.src = `${AUDIO_BASE}/${s.files.normalized}`;
}

/* ---------------- wiring ---------------- */

el.text.addEventListener('input', () => {
  clearTimeout(el.text._t);
  el.text._t = setTimeout(updatePreview, 220);
});
el.normalize.addEventListener('change', updatePreview);
el.speed.addEventListener('input', () => { SPEED_VAL.textContent = Number(el.speed.value).toFixed(2); });
el.pitch.addEventListener('input', () => { PITCH_VAL.textContent = el.pitch.value; });
el.voice.addEventListener('change', () => { activeSample = pickSample(); });

el.speak.addEventListener('click', () => {
  const text = el.text.value.trim();
  if (!text) { setStatus('Type something to speak.', 'error'); return; }

  const spoken = el.normalize.checked ? normalizeText(text) : text;
  const ok = speak(spoken, {
    rate: Number(el.speed.value) || 1,
    pitch: 1 + Number(el.pitch.value) / 24,
  });

  if (!ok) return;

  // Also surface the high-quality pre-rendered sample for the selected voice,
  // so you can compare a real TTS voice against the browser read.
  const s = pickSample();
  if (s?.files) {
    activeSample = s;
    loadSampleAudio();
    el.player.src = `${AUDIO_BASE}/${s.files.normalized}`;
    el.playerWrap.classList.remove('hidden');
    el.emptyState.classList.add('hidden');
    el.playerVoice.textContent = s.voice;
    el.playerMeta.textContent = `pre-rendered · ${s.label}`;
  }
  setStatus(hasSpeech
    ? 'Speaking your text with the browser voice. Play the pre-rendered sample below for a real TTS voice.'
    : 'Spoke your text.', 'ok');
});

el.ab.addEventListener('click', () => {
  const text = el.text.value.trim();
  if (!text) { setStatus('Type something to compare.', 'error'); return; }
  if (!hasSpeech) {
    setStatus('This browser has no speech synthesis available.', 'error');
    return;
  }
  // Read the raw text, then the normalized text, so the delta is audible on
  // the user's own copy rather than only on the fixed sample.
  const rate = Number(el.speed.value) || 1;
  const pitch = 1 + Number(el.pitch.value) / 24;
  const norm = normalizeText(text);

  synth.cancel();
  const u1 = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u1.voice = v; u1.lang = v.lang; }
  u1.rate = rate; u1.pitch = pitch;
  u1.onend = () => {
    const u2 = new SpeechSynthesisUtterance(norm);
    if (v) { u2.voice = v; u2.lang = v.lang; }
    u2.rate = rate; u2.pitch = pitch;
    u2.onend = () => setStatus('Raw first, then normalized. Notice the numbers and abbreviations.', 'ok');
    synth.speak(u2);
  };
  synth.speak(u1);
  setStatus('Reading raw text, then normalized text…', 'ok');
});

el.compare.addEventListener('click', () => {
  const s = pickSample();
  if (!s) { setStatus('No samples available.', 'error'); return; }
  activeSample = s;
  el.comparePanel.classList.remove('hidden');
  el.rawText.textContent = s.raw;
  el.normText.textContent = s.normalized;
  el.rawMeta.textContent = `${s.voice} · raw`;
  el.normMeta.textContent = `${s.voice} · normalized`;
  loadSampleAudio();
  playSample('raw');
  setStatus('Play both versions back to back.', 'ok');
});

el.closeCompare.addEventListener('click', () => {
  el.comparePanel.classList.add('hidden');
  el.rawPlayer.pause();
  el.normPlayer.pause();
});

el.sample.addEventListener('click', () => {
  const s = samples[Math.floor(Math.random() * samples.length)];
  if (!s) return;
  el.text.value = s.raw;
  el.voice.value = s.voice;
  activeSample = s;
  updatePreview();
});

el.reset.addEventListener('click', () => {
  el.text.value = '';
  el.player.pause();
  el.player.removeAttribute('src');
  el.playerWrap.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  el.comparePanel.classList.add('hidden');
  updatePreview();
  setStatus('');
});

loadSamples().then(() => {
  if (samples.length) {
    el.text.value = samples[0].raw;
    activeSample = samples[0];
    updatePreview();
  }
});
