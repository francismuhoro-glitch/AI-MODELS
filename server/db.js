'use strict';
/* Tiny JSON persistence layer — personal-scale, zero native deps. Data lives in data/state.json */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'state.json');

const EMPTY = {
  events: [], emails: [], messages: [], notes: [], briefs: [], tasks: [], chats: [], subscriptions: [],
  meta: { lastSync: null, lastBriefDate: null, seeded: false }
};

let db = null;
let saveTimer = null;

function load() {
  if (db) return db;
  try { db = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (_) { db = structuredClone(EMPTY); }
  // Convenience: allow state.find(...)/state.upsert(...)/state.one(...)
  db.find = (col, pred) => find(col, pred);
  db.one = (col, pred) => one(col, pred);
  db.upsert = (col, item, key) => upsert(col, item, key);
  return db;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  }, 150);
}

function saveNow() { clearTimeout(saveTimer); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

function upsert(collection, item, key = 'id') {
  const d = load();
  const i = d[collection].findIndex(x => x[key] === item[key]);
  if (i >= 0) d[collection][i] = { ...d[collection][i], ...item };
  else d[collection].push(item);
  save();
  return item;
}

function find(collection, pred) { return load()[collection].filter(pred || (() => true)); }
function one(collection, pred) { return load()[collection].find(pred || (() => true)); }

module.exports = { load, save, saveNow, upsert, find, one, DATA_DIR };
