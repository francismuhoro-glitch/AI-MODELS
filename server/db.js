'use strict';
const fs = require('fs');
const path = require('path');

const IS_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_VERCEL ? '/tmp' : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const INITIAL_DB = {
  events: [
    { id: 'ev-1', title: 'Strategy & Growth Sync', start: Date.now() + 3600000, end: Date.now() + 7200000, context: 'business', source: 'calendar' },
    { id: 'ev-2', title: 'Team Standup', start: Date.now() + 10800000, end: Date.now() + 12600000, context: 'day-job', source: 'calendar' }
  ],
  emails: [
    { id: 'em-1', from: 'finance@client.com', fromName: 'Client Finance', subject: 'Payment confirmation for Invoice #1042', snippet: 'Funds transferred via M-Pesa.', read: false, context: 'business', ts: Date.now() - 3600000 },
    { id: 'em-2', from: 'hr@company.com', fromName: 'HR Team', subject: 'Quarterly Review Schedule', snippet: 'Please book your time slot.', read: true, context: 'day-job', ts: Date.now() - 7200000 }
  ],
  inbox: [
    { id: 'task-1', title: 'Review supplier price updates', priority: 'high', done: false, context: 'business', ts: Date.now() },
    { id: 'task-2', title: 'Prepare monthly KPI summary', priority: 'medium', done: false, context: 'day-job', ts: Date.now() }
  ],
  notes: [
    { id: 'note-1', title: 'Welcome to ARIA', content: 'ARIA is your personal AI executive assistant with local intelligence and persistent memory.', source: 'system', tags: ['welcome', 'guide'], ts: Date.now() }
  ],
  messages: [
    { id: 'msg-1', channel: 'WhatsApp', from: 'Kamau', text: 'Invoice terms agreed. Proceed with order.', context: 'business', ts: Date.now() - 1800000 }
  ],
  chats: []
};

let memDb = null;

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function load() {
  if (memDb) return memDb;
  ensureDir();
  try {
    if (fs.existsSync(DB_FILE)) {
      memDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (_) {}
  if (!memDb) memDb = JSON.parse(JSON.stringify(INITIAL_DB));
  
  memDb.events = memDb.events || [];
  memDb.emails = memDb.emails || [];
  memDb.inbox = memDb.inbox || [];
  memDb.notes = memDb.notes || [];
  memDb.messages = memDb.messages || [];
  memDb.chats = memDb.chats || [];
  return memDb;
}

async function saveNow() {
  if (!memDb) return;
  ensureDir();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(memDb, null, 2), 'utf8');
  } catch (_) {}
}

function upsert(collection, item) {
  const db = load();
  if (!db[collection]) db[collection] = [];
  const idx = db[collection].findIndex(x => x.id === item.id);
  if (idx >= 0) db[collection][idx] = item;
  else db[collection].unshift(item);
}

module.exports = { load, saveNow, upsert };
