'use strict';
/* Settings — one JSON document ("settings") in the backing store.
   Serverless-safe: store.js writes to /tmp (or Supabase) when running on Vercel, and every
   write is wrapped so a read-only filesystem (EROFS) can never crash a request. */
const store = require('./store');

const DEFAULTS = {
  owner: {
    name: 'Francis Muhoro',
    timezone: 'Africa/Nairobi',
    location: { label: 'Nairobi, Kenya', lat: -1.2921, lon: 36.8219 }
  },
  wakeTime: '06:00',
  rhythm: { wakeHour: 6, workStartHour: 8, workEndHour: 17, sleepHour: 22 },
  llm: { provider: 'auto', ollamaUrl: 'http://127.0.0.1:11434', model: 'llama3.1' },
  /* Discretion mode: TTS output skips full email contents, long lists and sensitive strings
     (passwords, PINs, tokens, card numbers, addresses). Display text stays complete. */
  discretion: true,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', to: '' },
  brief: { email: false },
  telegram: { enabled: false, token: '', allowedChatId: '' },
  connectors: {
    demo: { enabled: false, config: {} },
    google: { enabled: false },
    microsoft: { enabled: false },
    slack: { enabled: false },
    whatsapp: { enabled: false }
  }
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/* Deep-merge `patch` into `base`, arrays replaced wholesale. */
function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(base && base[k] ? base[k] : {}, v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/* Fill in anything a stored (older / partial) settings document is missing so that
   every consumer — brief, scheduler, connectors, llm — can rely on the full shape. */
function normalize(cfg) {
  const out = merge(clone(DEFAULTS), cfg || {});
  out.owner = merge(clone(DEFAULTS.owner), out.owner || {});
  out.owner.location = merge(clone(DEFAULTS.owner.location), out.owner.location || {});
  out.llm = merge(clone(DEFAULTS.llm), out.llm || {});
  // Back-compat: an older build stored { ollama: { host, model } }
  if (cfg && cfg.ollama) {
    if (cfg.ollama.host) out.llm.ollamaUrl = cfg.ollama.host;
    if (cfg.ollama.model) out.llm.model = cfg.ollama.model;
  }
  out.smtp = merge(clone(DEFAULTS.smtp), out.smtp || {});
  out.brief = merge(clone(DEFAULTS.brief), out.brief || {});
  out.rhythm = merge(clone(DEFAULTS.rhythm), out.rhythm || {});
  out.discretion = out.discretion !== false;   // default ON — never leak secrets to TTS
  out.telegram = merge(clone(DEFAULTS.telegram), out.telegram || {});
  out.connectors = merge(clone(DEFAULTS.connectors), out.connectors || {});
  for (const key of Object.keys(DEFAULTS.connectors)) {
    out.connectors[key] = out.connectors[key] || { enabled: false };
    out.connectors[key].enabled = !!out.connectors[key].enabled;
  }
  if (!/^\d{2}:\d{2}$/.test(String(out.wakeTime || ''))) out.wakeTime = DEFAULTS.wakeTime;
  return out;
}

let cache = null;

/* Async load — used by init() at boot so a remote (Supabase) document is honoured. */
async function init() {
  if (cache) return cache;
  let doc = null;
  try { doc = await store.docGet('settings'); } catch (_) { doc = null; }
  cache = normalize(doc);
  return cache;
}

/* Sync load — every request handler uses this. Falls back to the local file (never throws). */
function load() {
  if (cache) return cache;
  let doc = null;
  try { doc = store.docGetSync('settings'); } catch (_) { doc = null; }
  cache = normalize(doc);
  return cache;
}

async function save(patch) {
  cache = normalize(merge(load(), patch || {}));
  try { await store.docSet('settings', cache); } catch (_) { /* read-only fs / offline store: keep in memory */ }
  return cache;
}

/* Test helper — drops the in-memory cache so the next load() re-reads the store. */
function _reset() { cache = null; }

module.exports = { init, load, save, normalize, DEFAULTS, _reset };
