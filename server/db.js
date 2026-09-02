'use strict';
/* Database — one JSON document ("state") held in memory and persisted through store.js.
   Two hard requirements this module has to satisfy:
     1. Serverless safety: on Vercel the filesystem is read-only outside /tmp, so every write is
        best-effort and a failure (EROFS) degrades to pure in-memory state instead of a 500.
     2. A stable shape: every collection ALWAYS exists as an array, so callers can do
        db.events.filter(...) / res.json(db.emails) without ever seeing `undefined`. */
const store = require('./store');

const COLLECTIONS = ['events', 'emails', 'messages', 'tasks', 'notes', 'briefs', 'chats', 'inbox', 'subscriptions'];

const seedTs = Date.now();

function seed() {
  return {
    events: [
      { id: 'ev-1', title: 'Strategy & Growth Sync', start: seedTs + 3600000, end: seedTs + 7200000, calendar: 'Business', context: 'business', source: 'seed', location: 'Google Meet', attendees: [] },
      { id: 'ev-2', title: 'Team Standup', start: seedTs + 10800000, end: seedTs + 12600000, calendar: 'Work', context: 'day-job', source: 'seed', location: 'Zoom', attendees: [] }
    ],
    emails: [
      { id: 'em-1', from: 'finance@client.com', fromName: 'Client Finance', subject: 'Payment confirmation for Invoice #1042', body: 'Funds transferred via M-Pesa.', snippet: 'Funds transferred via M-Pesa.', read: false, context: 'business', priority: 'medium', source: 'seed', receivedAt: seedTs - 3600000, ts: seedTs - 3600000 },
      { id: 'em-2', from: 'hr@company.com', fromName: 'HR Team', subject: 'Quarterly Review Schedule', body: 'Please book your time slot.', snippet: 'Please book your time slot.', read: true, context: 'day-job', priority: 'low', source: 'seed', receivedAt: seedTs - 7200000, ts: seedTs - 7200000 }
    ],
    messages: [
      { id: 'msg-1', channel: 'WhatsApp', from: 'Kamau', text: 'Invoice terms agreed. Proceed with order.', context: 'business', priority: 'medium', source: 'seed', sentAt: seedTs - 1800000, ts: seedTs - 1800000 }
    ],
    tasks: [
      { id: 'task-1', title: 'Review supplier price updates', priority: 'high', done: false, context: 'business', source: 'seed', due: null, createdAt: seedTs, ts: seedTs },
      { id: 'task-2', title: 'Prepare monthly KPI summary', priority: 'medium', done: false, context: 'day-job', source: 'seed', due: null, createdAt: seedTs, ts: seedTs }
    ],
    notes: [
      { id: 'note-1', title: 'Welcome to ARIA', content: 'ARIA is your personal AI executive assistant with local intelligence and persistent memory.', source: 'system', kind: 'note', tags: ['welcome', 'guide'], topics: ['aria', 'assistant'], entities: [], createdAt: seedTs, updatedAt: seedTs }
    ],
    briefs: [],
    chats: [],
    subscriptions: [],
    meta: { lastSync: null, lastBriefDate: null, createdAt: seedTs }
  };
}

let state = null;

/* Guarantee the full shape (and the helper methods) on any document we load. */
function hydrate(doc) {
  const base = doc && typeof doc === 'object' ? doc : seed();
  for (const c of COLLECTIONS) if (!Array.isArray(base[c])) base[c] = [];
  base.meta = base.meta || {};
  if (base.meta.lastSync === undefined) base.meta.lastSync = null;
  if (base.meta.lastBriefDate === undefined) base.meta.lastBriefDate = null;

  /* `inbox` is the app's action-item list; historically the same data lived under `tasks`.
     Keep them as ONE array under two names so both the API and the brain agree. */
  if (base.inbox.length && !base.tasks.length) base.tasks = base.inbox;
  base.inbox = base.tasks;

  Object.defineProperties(base, {
    find: { value: (col, pred) => (Array.isArray(base[col]) ? base[col] : []).filter(pred || (() => true)), enumerable: false, configurable: true },
    one: { value: (col, pred) => (Array.isArray(base[col]) ? base[col] : []).find(pred) || null, enumerable: false, configurable: true },
    upsert: { value: (col, item) => upsert(col, item), enumerable: false, configurable: true },
    remove: { value: (col, pred) => remove(col, pred), enumerable: false, configurable: true }
  });
  return base;
}

/* Async load — used at boot (honours a remote Supabase document). */
async function init() {
  if (state) return state;
  let doc = null;
  try { doc = await store.docGet('state'); } catch (_) { doc = null; }
  state = hydrate(doc);
  return state;
}

/* Sync load — used by every request handler. Never throws, never returns undefined. */
function load() {
  if (state) return state;
  let doc = null;
  try { doc = store.docGetSync('state'); } catch (_) { doc = null; }
  state = hydrate(doc);
  return state;
}

function collection(name) {
  const db = load();
  if (!Array.isArray(db[name])) db[name] = [];
  return db[name];
}

function upsert(col, item) {
  const list = collection(col);
  const idx = item && item.id != null ? list.findIndex(x => x && x.id === item.id) : -1;
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  if (col === 'tasks' || col === 'inbox') load().inbox = load().tasks;
  return item;
}

function remove(col, pred) {
  const db = load();
  const list = collection(col);
  const before = list.length;
  db[col] = list.filter(x => !pred(x));
  if (col === 'tasks' || col === 'inbox') { db.tasks = db[col]; db.inbox = db.tasks; }
  return before - db[col].length;
}

/* Persist. Best-effort by design: on a read-only filesystem this is a no-op instead of a crash. */
async function saveNow() {
  const db = load();
  try {
    const plain = {};
    for (const [k, v] of Object.entries(db)) plain[k] = v;
    await store.docSet('state', plain);
    return { saved: true };
  } catch (e) {
    return { saved: false, reason: e && e.message ? e.message : 'store unavailable' };
  }
}

/* Fire-and-forget variant (brain.autoGrow calls it synchronously). */
function save() { saveNow().catch(() => {}); }

function _reset() { state = null; }

module.exports = { init, load, save, saveNow, upsert, remove, collection, COLLECTIONS, seed, _reset };
