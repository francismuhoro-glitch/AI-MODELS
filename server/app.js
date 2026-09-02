'use strict';
const express = require('express');
const path = require('path');
const dbm = require('./db');
const cfgm = require('./config');
const brain = require('./brain');
const assistant = require('./assistant');
const weblearn = require('./weblearn');
const doclearn = require('./doclearn');
const { llmStatus } = require('./llm');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const apiRouter = express.Router();

/* --- 1. Comprehensive /api/state for Hub, Sidebar & Tabs --- */
apiRouter.get('/state', (req, res) => {
  try {
    const db = dbm.load();
    const cfg = cfgm.load();
    let engine = { activeEngine: 'offline-engine', model: 'none', label: 'Built-in Engine', ready: true };
    try { engine = llmStatus(); } catch (_) {}

    res.json({
      ok: true,
      cfg,
      owner: cfg.owner || { name: 'Francis Muhoro', timezone: 'Africa/Nairobi' },
      rhythm: cfg.rhythm || { wakeHour: 6, workStartHour: 8, workEndHour: 17, sleepHour: 22 },
      engine: engine || { activeEngine: 'offline-engine', model: 'none' },
      llm: engine || { activeEngine: 'offline-engine', model: 'none' },
      activeEngine: (engine && engine.activeEngine) || 'offline-engine',
      events: db.events || [],
      emails: db.emails || [],
      inbox: db.inbox || [],
      notes: db.notes || [],
      messages: db.messages || [],
      chats: db.chats || [],
      counts: {
        events: (db.events || []).length,
        emails: (db.emails || []).filter(e => !e.read).length,
        inbox: (db.inbox || []).filter(i => !i.done).length,
        notes: (db.notes || []).length,
        messages: (db.messages || []).length
      }
    });
  } catch (e) {
    res.json({
      ok: true,
      cfg: {},
      owner: { name: 'Francis Muhoro', timezone: 'Africa/Nairobi' },
      engine: { activeEngine: 'offline-engine', model: 'none' },
      llm: { activeEngine: 'offline-engine', model: 'none' },
      events: [],
      emails: [],
      inbox: [],
      notes: [],
      messages: [],
      chats: [],
      counts: { events: 0, emails: 0, inbox: 0, notes: 0, messages: 0 }
    });
  }
});

/* --- 2. Collection Routes (Inbox, Events, Emails, Messages) --- */
apiRouter.get('/inbox', (req, res) => {
  const db = dbm.load();
  res.json(db.inbox || []);
});

apiRouter.post('/inbox', async (req, res) => {
  const db = dbm.load();
  const item = { id: 'task-' + Date.now(), done: false, ts: Date.now(), ...req.body };
  db.inbox = db.inbox || [];
  db.inbox.unshift(item);
  await dbm.saveNow();
  res.json(item);
});

apiRouter.put('/inbox/:id', async (req, res) => {
  const db = dbm.load();
  const item = (db.inbox || []).find(i => i.id === req.params.id);
  if (item) {
    Object.assign(item, req.body);
    await dbm.saveNow();
    return res.json(item);
  }
  res.status(404).json({ error: 'not found' });
});

apiRouter.delete('/inbox/:id', async (req, res) => {
  const db = dbm.load();
  db.inbox = (db.inbox || []).filter(i => i.id !== req.params.id);
  await dbm.saveNow();
  res.json({ ok: true });
});

apiRouter.get('/events', (req, res) => {
  const db = dbm.load();
  res.json(db.events || []);
});

apiRouter.post('/events', async (req, res) => {
  const db = dbm.load();
  const ev = { id: 'ev-' + Date.now(), ...req.body };
  db.events = db.events || [];
  db.events.push(ev);
  await dbm.saveNow();
  brain.buildIndex();
  res.json(ev);
});

apiRouter.get('/emails', (req, res) => {
  const db = dbm.load();
  res.json(db.emails || []);
});

apiRouter.get('/messages', (req, res) => {
  const db = dbm.load();
  res.json(db.messages || []);
});

/* --- 3. Second Brain & Document Routes --- */
apiRouter.get('/notes', (req, res) => {
  const db = dbm.load();
  res.json(db.notes || []);
});

apiRouter.post('/notes', async (req, res) => {
  try {
    const { title, content, tags } = req.body || {};
    const note = brain.ingestNote({ title: title || 'Quick Note', content: content || '', source: 'user', tags: tags || [] });
    brain.buildIndex();
    await dbm.saveNow();
    res.json(note);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

apiRouter.post('/notes/from-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const note = await weblearn.learnFromUrl(url);
    res.json({ ok: true, note });
  } catch (e) {
    res.status(502).json({ error: e.message || 'could not read page' });
  }
});

apiRouter.post('/notes/upload', async (req, res) => {
  try {
    const { filename, content, base64, mimeType } = req.body || {};
    const buffer = base64 ? Buffer.from(base64, 'base64') : Buffer.from(content || '', 'utf8');
    const note = await doclearn.ingestDocument(filename || 'Document', buffer, mimeType);
    res.json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

apiRouter.delete('/notes/:id', async (req, res) => {
  try {
    const db = dbm.load();
    db.notes = (db.notes || []).filter(n => n.id !== req.params.id);
    await dbm.saveNow();
    brain.buildIndex();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

apiRouter.get('/search', (req, res) => {
  try {
    const q = req.query.q || '';
    const hits = brain.search(q, 10);
    res.json(hits);
  } catch (e) {
    res.json([]);
  }
});

/* --- 4. Assistant & Config Routes --- */
apiRouter.post('/assistant', async (req, res) => {
  try {
    const { message } = req.body || {};
    const result = await assistant.respond(message || '');
    res.json(result);
  } catch (e) {
    res.json({ reply: 'Sorry, I encountered an error: ' + e.message, engine: 'offline-engine' });
  }
});

apiRouter.get('/assistant/history', (req, res) => {
  const db = dbm.load();
  res.json(db.chats || []);
});

apiRouter.get('/config', (req, res) => {
  res.json(cfgm.load());
});

apiRouter.post('/config', async (req, res) => {
  try {
    const updated = await cfgm.save(req.body || {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use('/api', apiRouter);
app.use(apiRouter);

module.exports = app;
