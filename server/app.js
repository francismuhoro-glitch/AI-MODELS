'use strict';
const express = require('express');
const path = require('path');
const dbm = require('./db');
const cfgm = require('./config');
const brain = require('./brain');
const assistant = require('./assistant');
const weblearn = require('./weblearn');
const doclearn = require('./doclearn');

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

// Serve frontend static assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Create an isolated API router
const apiRouter = express.Router();

apiRouter.get('/state', (req, res) => {
  try {
    const db = dbm.load();
    const cfg = cfgm.load();
    res.json({
      cfg,
      owner: cfg.owner || { name: 'Francis Muhoro' },
      counts: {
        events: (db.events || []).length,
        emails: (db.emails || []).filter(e => !e.read).length,
        inbox: (db.inbox || []).filter(i => !i.done).length,
        notes: (db.notes || []).length
      },
      activeEngine: 'offline-engine',
      llm: { activeEngine: 'offline-engine', model: 'none' }
    });
  } catch (e) {
    res.json({ counts: { events: 0, emails: 0, inbox: 0, notes: 0 } });
  }
});

apiRouter.get('/emails', (req, res) => {
  try {
    const db = dbm.load();
    res.json(db.emails || []);
  } catch (e) {
    res.json([]);
  }
});

apiRouter.get('/events', (req, res) => {
  try {
    const db = dbm.load();
    res.json(db.events || []);
  } catch (e) {
    res.json([]);
  }
});

apiRouter.get('/inbox', (req, res) => {
  try {
    const db = dbm.load();
    res.json(db.inbox || []);
  } catch (e) {
    res.json([]);
  }
});

apiRouter.get('/notes', (req, res) => {
  try {
    const db = dbm.load();
    res.json(db.notes || []);
  } catch (e) {
    res.json([]);
  }
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
  try {
    const db = dbm.load();
    res.json(db.chats || []);
  } catch (e) {
    res.json([]);
  }
});

apiRouter.get('/config', (req, res) => {
  try {
    res.json(cfgm.load());
  } catch (e) {
    res.json({});
  }
});

apiRouter.post('/config', async (req, res) => {
  try {
    const updated = await cfgm.save(req.body || {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mount router under BOTH /api and root / (guarantees matching regardless of Vercel path rewrites)
app.use('/api', apiRouter);
app.use(apiRouter);

module.exports = app;
