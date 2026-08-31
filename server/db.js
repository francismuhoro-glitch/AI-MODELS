'use strict';
/* Persistence — one JSON document of state, backed by local file OR Supabase (see store.js).
   Personal scale, zero native deps. All data lives in the `state` doc; settings live in `settings`. */
const store = require('./store');
const cfgm = require('./config');

const EMPTY = {
  events: [], emails: [], messages: [], notes: [], briefs: [], tasks: [], chats: [], subscriptions: [],
  meta: { lastSync: null, lastBriefDate: null, seeded: false }
};

let db = null;
let saveTimer = null;
let readyPromise = null;

/* Called once before serving requests: loads state + settings from the backing store. */
function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const [savedState, savedSettings] = await Promise.all([store.docGet('state'), store.docGet('settings')]);
    cfgm.hydrate(savedSettings);
    db = { ...structuredClone(EMPTY), ...(savedState || {}) };
    attachHelpers();
    if (!savedState) await store.docSet('state', serialise());
  })();
  return readyPromise;
}

function attachHelpers() {
  // Convenience: allow state.find(...)/state.upsert(...)/state.one(...)
  db.find = (col, pred) => find(col, pred);
  db.one = (col, pred) => one(col, pred);
  db.upsert = (col, item, key) => upsert(col, item, key);
}

function serialise() {
  const clone = { ...db };
  delete clone.find; delete clone.one; delete clone.upsert;
  return clone;
}

/* Synchronous access — valid any time after init() (or lazily in local-file mode). */
function load() {
  if (db) return db;
  if (store.isRemote()) throw new Error('DB not initialised — await db.init() first (the server does this before routes).');
  db = { ...structuredClone(EMPTY), ...(store.docGetSync('state') || {}) };
  attachHelpers();
  return db;
}

function find(col, pred) { return load()[col].filter(pred || (() => true)); }
function one(col, pred) { return load()[col].find(pred || (() => true)); }

function upsert(collection, item, key = 'id') {
  const d = load();
  const i = d[collection].findIndex(x => x[key] === item[key]);
  if (i >= 0) d[collection][i] = { ...d[collection][i], ...item };
  else d[collection].push(item);
  save();
  return item;
}

/* Debounced background write (non-critical paths). */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { docSetSafe(); }, store.isRemote() ? 75 : 150);
}

/* Awaited write — use for anything you cannot afford to lose (briefs, settings, subscriptions). */
async function saveNow() {
  clearTimeout(saveTimer);
  await docSetSafe();
}

async function docSetSafe() {
  try { await store.docSet('state', serialise()); }
  catch (e) { console.error('[db] persist failed:', e.message); }
}

module.exports = { init, load, save, saveNow, upsert, find, one };
