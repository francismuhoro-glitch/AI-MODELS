'use strict';
/* Settings — one JSON document ("settings") in the backing store.
   Serverless-safe: store.js writes to /tmp (or Supabase) when running on Vercel, and every
   write is wrapped so a read-only filesystem (EROFS) can never crash a request. */
const store = require('./store');
const secrets = require('./secrets');

const LLM_PROVIDERS = ['auto', 'ollama', 'openai', 'offline'];
const VOICE_GENDERS = ['male', 'female'];

const DEFAULTS = {
  owner: {
    name: 'Francis Muhoro',
    timezone: 'Africa/Nairobi',
    location: { label: 'Nairobi, Kenya', lat: -1.2921, lon: 36.8219 }
  },
  wakeTime: '06:00',
  rhythm: { wakeHour: 6, workStartHour: 8, workEndHour: 17, sleepHour: 22 },
  /* ARIA's speaking voice. The owner asked for a MALE voice, so that is the default on a
     fresh install; the client mirrors it in localStorage 'aria.voiceGender' for an instant,
     per-device switch (Settings → "ARIA's voice"). */
  voiceGender: 'male',
  llm: {
    /* 'auto' = cloud (only when a key exists) → local Ollama → built-in offline engine. */
    provider: 'auto',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'openai/gpt-oss-120b',
    /* What ARIA recommends for a local model on modest hardware — shown in Settings. */
    recommendedModel: 'qwen2.5:7b',
    /* Any OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter, a local vLLM…). OFF by
       default: with no apiKey (and no OPENAI_API_KEY env) it is never contacted. */
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' }
  },
  /* Discretion mode: TTS output skips full email contents, long lists and sensitive strings
     (passwords, PINs, tokens, card numbers, addresses). Display text stays complete. */
  discretion: true,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', to: '' },
  brief: { email: false },
  telegram: { enabled: false, token: '', allowedChatId: '' },
  sms: { enabled: false, bridgeUrl: '', token: '' },
  media: { provider: 'browser', localUrl: '' },
  /* Android phone bridge (Tasker / MacroDroid). OFF by default: with no token saved and no
     explicit phone.* grants, no command can ever reach a device. Commands are queued in the
     outbox and stay unconfirmed until the phone acks them. */
  phone: {
    enabled: false,
    bridgeToken: '',
    label: 'Android phone',
    commandTtlSeconds: 1800,     // must be longer than the Tasker poll interval
    pollSeconds: 300
  },
  contacts: [],
  permissions: { grants: {}, allowGroupSend: false, autoSendRules: [] },
  routines: { morning: { enabled: true, steps: ['calendar_today', 'unread_summary'] } },
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
  out.llm.openai = merge(clone(DEFAULTS.llm.openai), (out.llm || {}).openai || {});
  if (!LLM_PROVIDERS.includes(out.llm.provider)) out.llm.provider = DEFAULTS.llm.provider;
  out.llm.ollamaUrl = String(out.llm.ollamaUrl || DEFAULTS.llm.ollamaUrl).replace(/\/+$/, '');
  out.llm.openai.baseUrl = String(out.llm.openai.baseUrl || DEFAULTS.llm.openai.baseUrl).replace(/\/+$/, '');
  out.llm.openai.apiKey = String(out.llm.openai.apiKey || '').trim();   // never logged, never echoed to /api/ai/status
  out.llm.openai.model = String(out.llm.openai.model || DEFAULTS.llm.openai.model);
  if (!out.llm.recommendedModel) out.llm.recommendedModel = DEFAULTS.llm.recommendedModel;
  // Back-compat: an older build stored { ollama: { host, model } }
  if (cfg && cfg.ollama) {
    if (cfg.ollama.host) out.llm.ollamaUrl = cfg.ollama.host;
    if (cfg.ollama.model) out.llm.model = cfg.ollama.model;
  }
  out.voiceGender = VOICE_GENDERS.includes(String(out.voiceGender || '').toLowerCase())
    ? String(out.voiceGender).toLowerCase() : DEFAULTS.voiceGender;
  out.smtp = merge(clone(DEFAULTS.smtp), out.smtp || {});
  out.brief = merge(clone(DEFAULTS.brief), out.brief || {});
  out.rhythm = merge(clone(DEFAULTS.rhythm), out.rhythm || {});
  out.discretion = out.discretion !== false;   // default ON — never leak secrets to TTS
  out.telegram = merge(clone(DEFAULTS.telegram), out.telegram || {});
  out.sms = merge(clone(DEFAULTS.sms), out.sms || {});
  out.media = merge(clone(DEFAULTS.media), out.media || {});
  out.phone = merge(clone(DEFAULTS.phone), out.phone || {});
  out.phone.enabled = !!out.phone.enabled;
  out.phone.bridgeToken = String(out.phone.bridgeToken || '').trim();
  out.phone.label = String(out.phone.label || DEFAULTS.phone.label).slice(0, 60);
  const phoneTtl = Number(out.phone.commandTtlSeconds);
  out.phone.commandTtlSeconds = Number.isFinite(phoneTtl) && phoneTtl >= 60
    ? Math.min(Math.round(phoneTtl), 86400) : DEFAULTS.phone.commandTtlSeconds;
  const phonePoll = Number(out.phone.pollSeconds);
  out.phone.pollSeconds = Number.isFinite(phonePoll) && phonePoll >= 15
    ? Math.min(Math.round(phonePoll), 86400) : DEFAULTS.phone.pollSeconds;
  out.permissions = merge(clone(DEFAULTS.permissions), out.permissions || {});
  out.permissions.grants = out.permissions.grants && typeof out.permissions.grants === 'object' ? out.permissions.grants : {};
  out.permissions.autoSendRules = Array.isArray(out.permissions.autoSendRules) ? out.permissions.autoSendRules : [];
  out.permissions.allowGroupSend = !!out.permissions.allowGroupSend;
  out.routines = merge(clone(DEFAULTS.routines), out.routines || {});
  out.contacts = Array.isArray(out.contacts) ? out.contacts : [];
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

function publicConfig(cfg) {
  const src = cfg || load();
  const out = secrets.redactTree(clone(src), src);
  out.llm = out.llm || {}; out.llm.openai = out.llm.openai || {};
  out.llm.openai.apiKey = '';
  out.llm.openai.apiKeyConfigured = !!openaiSecret(src);
  out.smtp = out.smtp || {}; out.smtp.pass = ''; out.smtp.passConfigured = !!(src && src.smtp && src.smtp.pass);
  out.telegram = out.telegram || {}; out.telegram.token = ''; out.telegram.tokenConfigured = !!(src && src.telegram && src.telegram.token);
  out.phone = out.phone || {};
  out.phone.bridgeToken = '';
  out.phone.bridgeTokenConfigured = !!(src && src.phone && src.phone.bridgeToken);
  return out;
}
function openaiSecret(cfg) { return String((cfg && cfg.llm && cfg.llm.openai && cfg.llm.openai.apiKey) || process.env.OPENAI_API_KEY || '').trim(); }

async function save(patch) {
  const current = load();
  const incoming = secrets.preserveBlanks(current, clone(patch || {}));
  cache = normalize(merge(current, incoming));
  try { await store.docSet('settings', cache); } catch (_) { /* read-only fs / offline store: keep in memory */ }
  return cache;
}

/* Test helper — drops the in-memory cache so the next load() re-reads the store. */
function _reset() { cache = null; }

module.exports = { init, load, save, normalize, publicConfig, DEFAULTS, _reset };
