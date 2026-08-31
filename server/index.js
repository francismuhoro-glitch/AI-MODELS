'use strict';
/* ARIA OS — server entry + API */
const express = require('express');
const path = require('path');
const cfgm = require('./config');
const dbm = require('./db');
const brain = require('./brain');
const assistant = require('./assistant');
const briefGen = require('./brief');
const connectors = require('./connectors');
const scheduler = require('./scheduler');
const { llmStatus, checkOllama } = require('./llm');
const { uid, dayKey, timeStr, priorityOf, scorePriority, classifyContext } = require('./util');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- Dashboard state ---------- */
app.get('/api/state', (req, res) => {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone;
  const today = dayKey(Date.now(), tz);
  const events = db.find('events', e => dayKey(e.start, tz) === today).sort((a, b) => a.start - b.start);
  const emails = db.find('emails').sort((a, b) => b.receivedAt - a.receivedAt);
  const messages = db.find('messages').sort((a, b) => b.sentAt - a.sentAt);
  const latestBrief = db.find('briefs').sort((a, b) => b.generatedAt - a.generatedAt)[0] || null;
  res.json({
    now: Date.now(), timezone: tz, wakeTime: cfg.wakeTime, owner: cfg.owner,
    brief: latestBrief,
    events, inbox: emails.slice(0, 25), inboxTotal: emails.length,
    unread: emails.filter(e => !e.read).length,
    messages: messages.slice(0, 20),
    tasks: db.find('tasks', t => !t.done).slice(0, 12),
    stats: {
      notes: db.find('notes').length, briefs: db.find('briefs').length,
      emails: emails.length, messages: messages.length, events: db.find('events').length,
      lastSync: db.meta.lastSync, engine: llmStatus().activeEngine
    }
  });
});

/* ---------- Brief ---------- */
app.post('/api/brief/generate', async (req, res) => {
  try { await connectors.syncAll(); res.json(await briefGen.generate({ trigger: 'manual' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/briefs', (req, res) => res.json(dbm.find('briefs').sort((a, b) => b.generatedAt - a.generatedAt)));
app.get('/api/briefs/:id', (req, res) => res.json(dbm.one('briefs', b => b.id === req.params.id) || null));

/* ---------- Calendar / Inbox / Messages ---------- */
app.get('/api/events', (req, res) => {
  const cfg = cfgm.load();
  const all = dbm.find('events').sort((a, b) => a.start - b.start);
  const days = +(req.query.days || 7);
  const from = Date.now() - 2 * 864e5;
  res.json(all.filter(e => e.start >= from && e.start <= Date.now() + days * 864e5));
});
app.get('/api/emails', (req, res) => res.json(dbm.find('emails').sort((a, b) => b.receivedAt - a.receivedAt)));
app.post('/api/emails/:id/read', (req, res) => {
  const em = dbm.one('emails', e => e.id === req.params.id); if (!em) return res.status(404).end();
  em.read = true; dbm.upsert('emails', em); res.json({ ok: true });
});
app.get('/api/messages', (req, res) => res.json(dbm.find('messages').sort((a, b) => b.sentAt - a.sentAt)));

/* ---------- Second brain ---------- */
app.get('/api/notes', (req, res) => res.json(dbm.find('notes').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)));
app.post('/api/notes', (req, res) => {
  const { title, content, tags } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const note = brain.ingestNote({ title: title || snippet(content, 60), content, source: 'manual', tags: tags || ['captured'] });
  brain.buildIndex();
  res.json(note);
});
app.delete('/api/notes/:id', (req, res) => {
  const db = dbm.load(); db.notes = db.notes.filter(n => n.id !== req.params.id); dbm.save(); brain.buildIndex(); res.json({ ok: true });
});
app.get('/api/search', (req, res) => res.json(brain.search(req.query.q || '', +(req.query.limit || 10))));
app.get('/api/tasks', (req, res) => res.json(dbm.find('tasks').sort((a, b) => (a.done - b.done) || (b.createdAt - a.createdAt))));
app.post('/api/tasks/:id/toggle', (req, res) => {
  const t = dbm.one('tasks', x => x.id === req.params.id); if (!t) return res.status(404).end();
  t.done = !t.done; dbm.upsert('tasks', t); res.json(t);
});
app.post('/api/tasks', (req, res) => {
  const t = { id: uid('task'), title: (req.body.title || '').slice(0, 140), due: req.body.due || null, source: 'manual', done: false, priority: 'medium', createdAt: Date.now() };
  dbm.upsert('tasks', t); res.json(t);
});

/* ---------- Assistant ---------- */
app.post('/api/assistant', async (req, res) => {
  try { res.json(await assistant.respond(String(req.body.message || '').slice(0, 2000))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/assistant/history', (req, res) => res.json(dbm.find('chats').sort((a, b) => a.ts - b.ts).slice(-60)));
app.post('/api/assistant/reset', (req, res) => {
  const db = dbm.load(); db.chats = []; dbm.save(); res.json({ ok: true });
});
app.get('/api/ai/status', async (req, res) => { await checkOllama(); res.json(llmStatus()); });

/* ---------- Settings & connectors ---------- */
app.get('/api/settings', (req, res) => {
  const cfg = cfgm.load();
  const safe = structuredClone(cfg);
  if (safe.smtp) safe.smtp.pass = safe.smtp.pass ? '********' : '';
  res.json(safe);
});
app.post('/api/settings', (req, res) => {
  const patch = req.body || {};
  if (patch.smtp && patch.smtp.pass === '********') delete patch.smtp.pass;
  const cfg = cfgm.save(patch);
  scheduler.start(); // re-arm schedules with new times
  res.json({ ok: true, wakeTime: cfg.wakeTime, timezone: cfg.owner.timezone });
});
app.get('/api/connectors', (req, res) => res.json(connectors.status()));
app.post('/api/connectors/:id', (req, res) => {
  const id = req.params.id;
  const patch = { connectors: { [id]: { enabled: !!req.body.enabled, ...req.body.config || {} } } };
  cfgm.save(patch); res.json({ ok: true, status: connectors.status() });
});
app.post('/api/sync', async (req, res) => {
  try { res.json(await connectors.syncAll()); } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Universal ingest (iOS Shortcuts, Zapier, n8n, scripts…) ----------
   POST /api/ingest  {type:'email'|'message'|'event'|'note', payload:{...}}          */
app.post('/api/ingest', (req, res) => {
  const { type, payload } = req.body || {};
  if (!payload) return res.status(400).json({ error: 'payload required' });
  const db = dbm.load();
  if (type === 'email') {
    const em = { id: payload.id || uid('em'), source: payload.source || 'api', from: payload.from || '', fromName: payload.fromName || payload.from || '', subject: payload.subject || '(no subject)', body: payload.body || '', snippet: (payload.body || '').slice(0, 200), receivedAt: payload.receivedAt || Date.now(), read: false, labels: [] };
    em.priorityScore = scorePriority(em); em.priority = priorityOf(em.priorityScore); em.context = classifyContext(em);
    db.upsert('emails', em);
  } else if (type === 'message') {
    const ms = { id: payload.id || uid('msg'), source: payload.source || 'api', channel: payload.channel || 'inbound', from: payload.from || 'unknown', text: payload.text || '', sentAt: payload.sentAt || Date.now(), read: false };
    ms.priorityScore = scorePriority(ms); ms.priority = priorityOf(ms.priorityScore); ms.context = classifyContext(ms);
    db.upsert('messages', ms);
  } else if (type === 'event') {
    db.upsert('events', { id: payload.id || uid('ev'), source: payload.source || 'api', calendar: payload.calendar || 'Personal', title: payload.title || '(untitled)', start: +payload.start || Date.now(), end: +payload.end || (+payload.start || Date.now()) + 36e5, location: payload.location || '', attendees: payload.attendees || [], notes: payload.notes || '' });
  } else if (type === 'note') {
    brain.ingestNote({ title: payload.title || 'Captured note', content: payload.content || '', source: 'api', tags: payload.tags || ['api'] });
    brain.buildIndex();
  } else return res.status(400).json({ error: 'type must be email|message|event|note' });
  brain.autoGrow();
  res.json({ ok: true });
});
/* WhatsApp Cloud API webhook endpoint */
app.get('/api/ingest/whatsapp', (req, res) => res.send(req.query['hub.challenge'] || 'ok'));
app.post('/api/ingest/whatsapp', (req, res) => {
  try {
    for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const m of value.messages || []) {
        const ms = { id: `wa-${m.id}`, source: 'whatsapp', channel: 'WhatsApp inbound', from: m.from || 'unknown', text: m.text?.body || '', sentAt: +(m.timestamp || Date.now() / 1000) * 1000, read: false };
        ms.priorityScore = scorePriority(ms); ms.priority = priorityOf(ms.priorityScore); ms.context = classifyContext(ms);
        dbm.upsert('messages', ms);
      }
    }
  } catch (_) {}
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'ARIA OS', ts: Date.now() }));

/* ---------- Boot ---------- */
(async () => {
  // First run: seed demo data so the OS is alive immediately
  const db = dbm.load();
  if (!db.meta.seeded) {
    await connectors.syncAll();
    db.meta.seeded = true; dbm.save();
    console.log('[boot] demo data seeded — second brain learning…');
  }
  scheduler.start();
  app.listen(PORT, '0.0.0.0', () => console.log(`ARIA OS running → http://0.0.0.0:${PORT}`));
})();
