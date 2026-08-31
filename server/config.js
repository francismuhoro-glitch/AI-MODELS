'use strict';
/* Settings: defaults + user overrides.
   Local mode: persisted to data/settings.json.
   Supabase mode: persisted to the aria_docs store (via db layer). */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DATA_DIR = store.dataDir();
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  owner: { name: 'Boss', timezone: 'Africa/Nairobi', location: { lat: -1.3733, lon: 36.9183, label: 'Mlolongo, KE' } },
  wakeTime: '06:00',
  brief: { email: true, dashboard: true },
  llm: { provider: 'auto', ollamaUrl: 'http://127.0.0.1:11434', model: 'llama3.1' },
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', to: '' },
  connectors: {
    demo: { enabled: true },
    google: { enabled: false, clientId: '', clientSecret: '', refreshToken: '' },
    microsoft: { enabled: false, accessToken: '' },
    slack: { enabled: false, userToken: '' },
    whatsapp: { enabled: false, accessToken: '', phoneNumberId: '' }
  }
};

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}
  cache = deepMerge(structuredClone(DEFAULTS), saved);
  return cache;
}

/* Called by db.init(): merge settings restored from the backing store (Supabase mode). */
function hydrate(savedSettings) {
  if (savedSettings && typeof savedSettings === 'object') cache = deepMerge(load(), savedSettings);
  return cache;
}

async function save(patch) {
  cache = deepMerge(load(), patch || {});
  if (store.isRemote()) {
    await store.docSet('settings', cache);
  } else {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[config] persist failed:', e.message); }
  }
  return cache;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

module.exports = { load, save, hydrate, DATA_DIR };
