/* TTS Lab — client */

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

const SAMPLES = [
  {
    label: 'Numbers & money',
    text: 'We closed 912 accounts last quarter, and the discrepancy rate dropped to 2.4%, which is below our target of 5%. Q3 revenue came in at $1,234.56 per account, up 18% YoY. Dr. Chen flagged that the Q3 figures are now final, so please review them by Friday at 3pm.',
  },
  {
    label: 'Plain prose',
    text: 'Hi there. I wanted to walk you through the invoice reconciliation workflow. We closed nine hundred and twelve accounts last quarter, and the discrepancy rate dropped to two point four percent, which is comfortably below our target of five percent. Let me know if you need anything else.',
  },
  {
    label: 'Abbreviations',
    text: 'The FY24 report is due from Dept. Finance by EOD. Approx. 45% of the discrepancy was caused by missing SKU codes. Please see the appendix for details, or ping me at 555-123-4567 if you need help.',
  },
];

let currentAudioUrl = null;

/* ---------------- helpers ---------------- */

function setStatus(msg, kind = '') {
  el.status.textContent = msg;
  el.status.className = `status ${kind}`;
}

function setBusy(busy) {
  el.speak.disabled = busy;
  el.compare.disabled = busy;
  el.speak.textContent = busy ? 'Synthesizing…' : 'Synthesize';
}

/** Diff two strings at word level and wrap changed spans. */
function highlightDiff(before, after) {
  const bWords = before.split(/(\s+)/);
  const aWords = after.split(/(\s+)/);
  const bSet = new Set(bWords.filter((w) => w.trim()));
  const aSet = new Set(aWords.filter((w) => w.trim()));

  const out = aWords
    .map((w) => {
      if (!w.trim()) return w;
      if (!bSet.has(w)) return `<span class="changed">${escapeHtml(w)}</span>`;
      return escapeHtml(w);
    })
    .join('');

  const added = [...aSet].filter((w) => !bSet.has(w)).length;
  return { html: out, added };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- data ---------------- */

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    el.engineLabel.textContent = h.engine;
    el.engine.value = h.engine;
    if (!h.hasApiKey && h.engine === 'nvidia-hosted') {
      el.engineBadge.textContent = 'needs API key';
      el.engineBadge.className = 'badge warn';
    } else {
      el.engineBadge.textContent = h.engine;
      el.engineBadge.className = 'badge';
    }
  } catch {
    el.engineLabel.textContent = 'offline';
  }
}

async function loadVoices() {
  const engine = el.engine.value;
  el.voice.innerHTML = '<option>loading…</option>';
  try {
    const res = await fetch(`/api/voices?engine=${encodeURIComponent(engine)}`);
    const data = await res.json();
    if (!data.voices?.length) {
      el.voice.innerHTML = '<option value="">no voices available</option>';
      return;
    }
    // Group by language for the Matrix engine, flat for Magpie.
    const groups = new Map();
    for (const v of data.voices) {
      const g = v.group || 'other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(v);
    }
    el.voice.innerHTML = '';
    for (const [g, list] of groups) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const v of list) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.name || v.id;
        og.appendChild(o);
      }
      el.voice.appendChild(og);
    }
  } catch (err) {
    el.voice.innerHTML = '<option value="">voice list failed</option>';
    setStatus(`Could not load voices: ${err.message}`, 'error');
  }
}

async function updateNormalizedPreview() {
  const text = el.text.value;
  if (!text.trim()) {
    el.normalized.innerHTML = '<span class="muted sm">Type something above…</span>';
    return;
  }
  try {
    const res = await fetch(`/api/normalize?text=${encodeURIComponent(text)}`);
    const data = await res.json();
    if (el.normalize.checked) {
      const { html, added } = highlightDiff(text, data.output);
      el.normalized.innerHTML = html;
      el.normalized.title = `${added} token(s) rewritten for speech`;
    } else {
      el.normalized.textContent = text;
    }
  } catch {
    el.normalized.textContent = text;
  }
}

/* ---------------- synthesis ---------------- */

function currentVoiceId() {
  // The Matrix engine expects a flat voice_id; Magpie expects its full name.
  return el.voice.value;
}

function buildPayload(text) {
  const engine = el.engine.value;
  const payload = {
    text,
    engine,
    language: el.language.value,
    voice: currentVoiceId(),
  };
  if (engine === 'matrix') {
    payload.speed = Number(el.speed.value);
    payload.pitch = Number(el.pitch.value);
    if (el.emotion.value) payload.emotion = el.emotion.value;
  }
  return payload;
}

async function synthesizeTo(text) {
  const res = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload(text)),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.error || detail;
    } catch {}
    throw new Error(detail);
  }
  const blob = await res.blob();
  const voice = res.headers.get('X-TTS-Voice') || '';
  const engine = res.headers.get('X-TTS-Engine') || '';
  return { url: URL.createObjectURL(blob), blob, voice, engine, size: blob.size };
}

async function doSpeak() {
  const raw = el.text.value.trim();
  if (!raw) {
    setStatus('Enter some text first.', 'error');
    return;
  }

  setBusy(true);
  setStatus('Synthesizing…');

  try {
    // The server always normalizes internally; the toggle only controls the
    // preview. For a true raw comparison we ask the engine directly.
    const text = raw;
    const result = await synthesizeTo(text);
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = result.url;

    el.player.src = result.url;
    el.player.play().catch(() => {});
    el.playerWrap.classList.remove('hidden');
    el.emptyState.classList.add('hidden');
    el.playerVoice.textContent = result.voice || '—';
    el.playerMeta.textContent = `${result.engine} · ${(result.size / 1024).toFixed(1)} KB`;

    const ms = Date.now() - t0;
    setStatus(`Done in ${ms} ms · ${(result.size / 1024).toFixed(1)} KB`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

let t0 = Date.now();

async function doCompare() {
  const raw = el.text.value.trim();
  if (!raw) {
    setStatus('Enter some text first.', 'error');
    return;
  }

  setBusy(true);
  el.comparePanel.classList.remove('hidden');
  el.rawText.textContent = raw;
  el.normText.textContent = '…';
  el.rawMeta.textContent = '';
  el.normMeta.textContent = '';
  setStatus('Rendering both versions…');

  try {
    const norm = await fetch(`/api/normalize?text=${encodeURIComponent(raw)}`).then((r) => r.json());
    el.normText.textContent = norm.output;

    const [a, b] = await Promise.all([
      synthesizeTo(raw),
      synthesizeTo(norm.output),
    ]);

    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    el.rawPlayer.src = a.url;
    el.normPlayer.src = b.url;
    el.rawMeta.textContent = `${a.voice} · ${(a.size / 1024).toFixed(1)} KB`;
    el.normMeta.textContent = `${b.voice} · ${(b.size / 1024).toFixed(1)} KB`;

    setStatus('Both versions ready — play them back to back.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

/* ---------------- wiring ---------------- */

el.engine.addEventListener('change', loadVoices);
el.text.addEventListener('input', () => {
  t0 = Date.now();
  clearTimeout(el.text._t);
  el.text._t = setTimeout(updateNormalizedPreview, 260);
});
el.normalize.addEventListener('change', updateNormalizedPreview);
el.speed.addEventListener('input', () => { $('speedVal').textContent = Number(el.speed.value).toFixed(2); });
el.pitch.addEventListener('input', () => { $('pitchVal').textContent = el.pitch.value; });

el.speak.addEventListener('click', () => { t0 = Date.now(); doSpeak(); });
el.compare.addEventListener('click', doCompare);
el.closeCompare.addEventListener('click', () => el.comparePanel.classList.add('hidden'));

el.sample.addEventListener('click', () => {
  const s = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  el.text.value = s.text;
  updateNormalizedPreview();
});

el.reset.addEventListener('click', () => {
  el.text.value = '';
  el.player.pause();
  el.player.removeAttribute('src');
  el.playerWrap.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  el.comparePanel.classList.add('hidden');
  updateNormalizedPreview();
  setStatus('');
});

loadHealth();
loadVoices();
