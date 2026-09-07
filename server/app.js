'use strict';
/* ARIA OS — HTTP layer.
   Exported as an express app that works BOTH as a long-lived server (server/index.js)
   and as a Vercel serverless function (api/index.js).

   Two contract rules everything below obeys:
     1. Every collection endpoint answers with an ARRAY (never undefined/null).
     2. /api/state answers with the COMPLETE object the frontend renders from —
        engine, owner, rhythm, cfg, timezone, stats, counts and every collection. */
const express = require('express');
const path = require('path');

const dbm = require('./db');
const cfgm = require('./config');
const brain = require('./brain');
const assistant = require('./assistant');
const agency = require('./agency');
const weblearn = require('./weblearn');
const doclearn = require('./doclearn');
const briefGen = require('./brief');
const connectors = require('./connectors');
const push = require('./push');
const { llmStatus, checkOllama } = require('./llm');
const alarms = require('./alarms');
const permissions = require('./permissions');
const integrations = require('./integrations');
const messaging = require('./messaging');
const media = require('./media');
const secrets = require('./secrets');
const automation = require('./automation');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ARIA-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* --- Vercel path normalization ---------------------------------------------------------
   The rewrite in vercel.json sends /api/<route> to api/index.js. Depending on the runtime
   the function may see the original path (/api/emails) OR the rewritten one (/emails, or
   even /api/index.js?path=…). Normalizing here means the router below matches in all cases,
   and the routes are ALSO dual-mounted at "/" and "/api" further down. */
app.use((req, res, next) => {
  if (req.url.startsWith('/api/index.js')) {
    const q = req.url.indexOf('?');
    req.url = '/api' + (q >= 0 ? req.url.slice(q) : '');
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const arr = (v) => (Array.isArray(v) ? v : []);
const ok = (res, value) => res.status(200).json(value);
const fail = (res, e, fallback) => {
  console.error('[api]', (e && e.stack) || e);
  if (fallback !== undefined) return res.status(200).json(fallback);
  return res.status(500).json({ error: (e && e.message) || 'internal error' });
};

const api = express.Router();

/* ---------------- health ---------------- */
api.get('/health', (req, res) => ok(res, { ok: true, ts: Date.now(), serverless: !!process.env.VERCEL }));

/* ---------------- state (the frontend's single source of truth) ---------------- */
function buildState() {
  const db = dbm.load();
  const cfg = cfgm.load();

  let engine;
  try { engine = llmStatus(); } catch (_) { engine = null; }
  engine = engine || { provider: 'offline', activeEngine: 'offline', model: '', ollamaReachable: false, models: [] };

  const events = arr(db.events).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
  const emails = arr(db.emails).slice().sort((a, b) => (b.receivedAt || b.ts || 0) - (a.receivedAt || a.ts || 0));
  const messages = arr(db.messages).slice().sort((a, b) => (b.sentAt || b.ts || 0) - (a.sentAt || a.ts || 0));
  const tasks = arr(db.tasks).filter(t => !t.done);
  const notes = arr(db.notes);
  const chats = arr(db.chats);
  const briefs = arr(db.briefs).slice().sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
  const agencyRuns = arr(db.agencyRuns).slice().sort((a, b) => (b.startedAt || b.ts || 0) - (a.startedAt || a.ts || 0));
  const unread = emails.filter(e => !e.read).length;

  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const todayEvents = events.filter(e => sameDay(e.start, tz));

  const alarmItems = arr(db.alarms).filter(a => a && (a.status === 'scheduled' || a.status === 'snoozed')).map(alarms.publicItem);
  const reminderItems = arr(db.reminders).filter(r => r && (r.status === 'scheduled' || r.status === 'open' || r.status === 'snoozed')).map(alarms.publicItem);

  return {
    ok: true,
    cfg: cfgm.publicConfig(cfg),
    owner: cfg.owner,
    rhythm: cfg.rhythm,
    timezone: tz,
    wakeTime: cfg.wakeTime,
    voiceGender: cfg.voiceGender || 'male',
    engine,
    llm: engine,
    activeEngine: engine.activeEngine || 'offline',
    unread,
    /* Collections — always arrays. */
    events: todayEvents.length ? todayEvents : events.slice(0, 12),
    allEvents: events,
    emails,
    inbox: emails.filter(e => !e.read).length ? emails.filter(e => !e.read) : emails,
    tasks,
    messages,
    notes,
    chats,
    briefs,
    brief: briefs[0] || null,
    agencyRuns,
    agents: agency.listAgents(),
    alarms: alarmItems,
    reminders: reminderItems,
    integrations: integrations.status(),
    pendingConfirmation: permissions.publicConfirmation(permissions.latestPending()),
    stats: {
      engine: engine.activeEngine || 'offline',
      lastSync: (db.meta && db.meta.lastSync) || null,
      notes: notes.length,
      briefs: briefs.length,
      emails: emails.length,
      messages: messages.length,
      events: events.length,
      tasks: tasks.length,
      agencyRuns: agencyRuns.length,
      alarms: alarmItems.length,
      reminders: reminderItems.length
    },
    counts: {
      events: events.length,
      emails: unread,
      inbox: tasks.length,
      notes: notes.length,
      messages: messages.length,
      chats: chats.length,
      briefs: briefs.length,
      agencyRuns: agencyRuns.length,
      alarms: alarmItems.length,
      reminders: reminderItems.length
    }
  };
}

function sameDay(ts, tz) {
  if (!ts) return false;
  try {
    const f = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return f(new Date(ts)) === f(new Date());
  } catch (_) { return false; }
}

api.get('/state', (req, res) => {
  try {
    checkOllama().catch(() => {});   // refresh engine status in the background
    ok(res, buildState());
  } catch (e) {
    /* Never let the hub go blank: answer with an empty-but-complete payload. */
    const cfg = (() => { try { return cfgm.load(); } catch (_) { return cfgm.DEFAULTS; } })();
    fail(res, e, {
      ok: true, cfg: cfgm.publicConfig(cfg), owner: cfg.owner, rhythm: cfg.rhythm,
      timezone: cfg.owner.timezone, wakeTime: cfg.wakeTime,
      engine: { activeEngine: 'offline', model: '' }, llm: { activeEngine: 'offline', model: '' },
      activeEngine: 'offline', unread: 0,
      events: [], allEvents: [], emails: [], inbox: [], tasks: [], messages: [], notes: [], chats: [], briefs: [], brief: null,
      agencyRuns: [], agents: [],
      stats: { engine: 'offline', lastSync: null, notes: 0, briefs: 0, emails: 0, messages: 0, events: 0, tasks: 0, agencyRuns: 0 },
      counts: { events: 0, emails: 0, inbox: 0, notes: 0, messages: 0, chats: 0, briefs: 0, agencyRuns: 0 }
    });
  }
});

/* ---------------- settings & config ---------------- */
api.get('/settings', (req, res) => { try { ok(res, cfgm.publicConfig(cfgm.load())); } catch (e) { fail(res, e, cfgm.publicConfig(cfgm.DEFAULTS)); } });
api.get('/config', (req, res) => { try { ok(res, cfgm.publicConfig(cfgm.load())); } catch (e) { fail(res, e, cfgm.publicConfig(cfgm.DEFAULTS)); } });

async function saveSettings(req, res) {
  try {
    const updated = await cfgm.save(req.body || {});
    const rearm = req.app.get('rearm');
    if (typeof rearm === 'function') { try { rearm(); } catch (_) {} }
    ok(res, cfgm.publicConfig(updated));
  } catch (e) { fail(res, e); }
}
api.post('/settings', saveSettings);
api.post('/config', saveSettings);

/* ---------------- events / calendar ---------------- */
api.get('/events', (req, res) => {
  try {
    const db = dbm.load();
    const days = Number(req.query.days);
    let events = arr(db.events).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
    if (Number.isFinite(days) && days > 0) {
      const until = Date.now() + days * 864e5;
      const from = Date.now() - 864e5;
      events = events.filter(e => (e.start || 0) >= from && (e.start || 0) <= until);
    }
    ok(res, events);
  } catch (e) { fail(res, e, []); }
});

api.post('/events', async (req, res) => {
  try {
    const body = req.body || {};
    const ev = {
      id: body.id || 'ev-' + Date.now(),
      title: body.title || 'Event',
      start: body.start || Date.now(),
      end: body.end || (body.start || Date.now()) + 36e5,
      calendar: body.calendar || 'Work',
      location: body.location || '',
      attendees: arr(body.attendees),
      source: body.source || 'manual',
      context: body.context || 'day-job'
    };
    dbm.upsert('events', ev);
    await dbm.saveNow();
    try { brain.buildIndex(); } catch (_) {}
    ok(res, ev);
  } catch (e) { fail(res, e); }
});

api.delete('/events/:id', async (req, res) => {
  try { dbm.remove('events', e => e.id === req.params.id); await dbm.saveNow(); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

/* ---------------- emails ---------------- */
api.get('/emails', (req, res) => {
  try {
    const db = dbm.load();
    ok(res, arr(db.emails).slice().sort((a, b) => (b.receivedAt || b.ts || 0) - (a.receivedAt || a.ts || 0)));
  } catch (e) { fail(res, e, []); }
});

api.get('/emails/:id', (req, res) => {
  try { ok(res, dbm.load().one('emails', e => e.id === req.params.id) || null); }
  catch (e) { fail(res, e, null); }
});

api.post('/emails/:id/read', async (req, res) => {
  try {
    const em = dbm.load().one('emails', e => e.id === req.params.id);
    if (!em) return res.status(404).json({ error: 'not found' });
    em.read = true;
    dbm.upsert('emails', em);
    await dbm.saveNow();
    ok(res, em);
  } catch (e) { fail(res, e); }
});

/* ---------------- messages ---------------- */
api.get('/messages', (req, res) => {
  try {
    const db = dbm.load();
    ok(res, arr(db.messages).slice().sort((a, b) => (b.sentAt || b.ts || 0) - (a.sentAt || a.ts || 0)));
  } catch (e) { fail(res, e, []); }
});

/* ---------------- inbox / tasks (same collection, two names) ---------------- */
api.get('/inbox', (req, res) => { try { ok(res, arr(dbm.load().tasks)); } catch (e) { fail(res, e, []); } });
api.get('/tasks', (req, res) => { try { ok(res, arr(dbm.load().tasks)); } catch (e) { fail(res, e, []); } });

async function addTask(req, res) {
  try {
    const body = req.body || {};
    const item = {
      id: body.id || 'task-' + Date.now(),
      title: body.title || 'Untitled task',
      priority: body.priority || 'medium',
      context: body.context || 'day-job',
      source: body.source || 'manual',
      due: body.due || null,
      done: false,
      createdAt: Date.now(),
      ts: Date.now()
    };
    dbm.upsert('tasks', item);
    await dbm.saveNow();
    ok(res, item);
  } catch (e) { fail(res, e); }
}
api.post('/inbox', addTask);
api.post('/tasks', addTask);

async function updateTask(req, res) {
  try {
    const item = dbm.load().one('tasks', t => t.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    Object.assign(item, req.body || {});
    dbm.upsert('tasks', item);
    await dbm.saveNow();
    ok(res, item);
  } catch (e) { fail(res, e); }
}
api.put('/inbox/:id', updateTask);
api.put('/tasks/:id', updateTask);

async function toggleTask(req, res) {
  try {
    const item = dbm.load().one('tasks', t => t.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    item.done = !item.done;
    dbm.upsert('tasks', item);
    await dbm.saveNow();
    ok(res, item);
  } catch (e) { fail(res, e); }
}
api.post('/inbox/:id/toggle', toggleTask);
api.post('/tasks/:id/toggle', toggleTask);

async function deleteTask(req, res) {
  try { dbm.remove('tasks', t => t.id === req.params.id); await dbm.saveNow(); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
}
api.delete('/inbox/:id', deleteTask);
api.delete('/tasks/:id', deleteTask);

/* ---------------- second brain ---------------- */
api.get('/notes', (req, res) => {
  try {
    ok(res, arr(dbm.load().notes).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  } catch (e) { fail(res, e, []); }
});

api.post('/notes', async (req, res) => {
  try {
    const { title, content, tags } = req.body || {};
    const note = brain.ingestNote({ title: title || 'Quick Note', content: content || '', source: 'user', tags: arr(tags) });
    brain.buildIndex();
    await dbm.saveNow();
    ok(res, note);
  } catch (e) { fail(res, e); }
});

api.post('/notes/from-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const note = await weblearn.learnFromUrl(url);
    ok(res, { ok: true, note });
  } catch (e) { res.status(502).json({ error: e.message || 'could not read page' }); }
});

api.post('/notes/upload', async (req, res) => {
  try {
    const { filename, content, base64, mimeType } = req.body || {};
    const buffer = base64 ? Buffer.from(base64, 'base64') : Buffer.from(content || '', 'utf8');
    const note = await doclearn.ingestDocument(filename || 'Document', buffer, mimeType);
    ok(res, { ok: true, note });
  } catch (e) { fail(res, e); }
});

api.delete('/notes/:id', async (req, res) => {
  try {
    dbm.remove('notes', n => n.id === req.params.id);
    await dbm.saveNow();
    try { brain.buildIndex(); } catch (_) {}
    ok(res, { ok: true });
  } catch (e) { fail(res, e); }
});

api.get('/search', async (req, res) => {
  /* Hybrid search: lexical BM25 blended with embeddings when an embedding backend is live.
     Offline it degrades to exactly the old lexical behaviour. */
  try { ok(res, arr(await brain.searchAsync(req.query.q || '', 10))); }
  catch (_) {
    try { ok(res, arr(brain.search(req.query.q || '', 10))); }
    catch (e) { fail(res, e, []); }
  }
});

/* ---------------- briefs ---------------- */
api.get('/briefs', (req, res) => {
  try { ok(res, arr(dbm.load().briefs).slice().sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0))); }
  catch (e) { fail(res, e, []); }
});

api.get('/briefs/:id', (req, res) => {
  try {
    const b = dbm.load().one('briefs', x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    ok(res, b);
  } catch (e) { fail(res, e); }
});

api.post('/brief/generate', async (req, res) => {
  try { ok(res, await briefGen.generate({ trigger: 'manual' })); }
  catch (e) { fail(res, e); }
});

/* ---------------- connectors & sync ---------------- */
api.get('/connectors', (req, res) => { try { ok(res, arr(connectors.status())); } catch (e) { fail(res, e, []); } });

api.post('/connectors/:id', async (req, res) => {
  try {
    const { enabled, config } = req.body || {};
    const patch = { connectors: { [req.params.id]: { enabled: !!enabled, ...(config || {}) } } };
    ok(res, cfgm.publicConfig(await cfgm.save(patch)));
  } catch (e) { fail(res, e); }
});

api.post('/sync', async (req, res) => {
  try { ok(res, await connectors.syncAll()); }
  catch (e) { fail(res, e, { ok: false, results: {}, lastSync: null }); }
});

api.post('/demo/purge', async (req, res) => {
  try {
    const removed = {};
    for (const col of ['emails', 'messages', 'events', 'notes', 'tasks']) {
      removed[col] = dbm.remove(col, x => x && (x.demo === true || String(x.id || '').startsWith('demo-')));
    }
    await dbm.saveNow();
    try { brain.buildIndex(); } catch (_) {}
    ok(res, { ok: true, removed });
  } catch (e) { fail(res, e); }
});

/* ---------------- assistant ---------------- */
api.post('/assistant', async (req, res) => {
  try {
    const { message } = req.body || {};
    const result = await assistant.respond(message || '');
    ok(res, result || { reply: '', engine: 'offline-engine' });
  } catch (e) {
    console.error('[assistant]', (e && e.stack) || e);
    ok(res, { reply: 'Sorry, I hit an error: ' + ((e && e.message) || 'unknown'), engine: 'offline-engine' });
  }
});

api.get('/assistant/history', (req, res) => {
  try { ok(res, arr(dbm.load().chats)); }
  catch (e) { fail(res, e, []); }
});

api.delete('/assistant/history', async (req, res) => {
  try { dbm.remove('chats', () => true); await dbm.saveNow(); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

api.get('/ai/status', async (req, res) => {
  try {
    await checkOllama().catch(() => {});
    ok(res, llmStatus());
  } catch (e) { fail(res, e, { provider: 'offline', activeEngine: 'offline', model: '', ollamaReachable: false, models: [] }); }
});

/* ---------------- agency swarm (multi-agent) ----------------
   ARIA (DirectorAgent) delegates a mission to a swarm of background specialists and
   answers with the final output PLUS the full agent trace, so the UI can replay who did
   what. Everything is deterministic and offline-safe; a local LLM only sharpens the prose. */
api.get('/agency/agents', (req, res) => {
  try { ok(res, arr(agency.listAgents())); } catch (e) { fail(res, e, []); }
});

api.get('/agency/runs', (req, res) => {
  try { ok(res, arr(agency.history(Number(req.query.limit) || 20))); } catch (e) { fail(res, e, []); }
});

api.get('/agency/runs/:id', (req, res) => {
  try {
    const run = arr(agency.history(agency.MAX_RUNS)).find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    ok(res, run);
  } catch (e) { fail(res, e); }
});

/* Plan only — lets the UI render the queued steps before the swarm starts working. */
api.post('/agency/plan', (req, res) => {
  try {
    const { task, agents } = req.body || {};
    if (!String(task || '').trim()) return res.status(400).json({ error: 'task required' });
    ok(res, agency.plan(task, agents));
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    fail(res, e);
  }
});

api.post('/agency/run', async (req, res) => {
  try {
    const { task, agents, mode, allowWeb } = req.body || {};
    if (!String(task || '').trim()) return res.status(400).json({ error: 'task required' });
    const result = await agency.run({ task, agents, mode, allowWeb });
    ok(res, result);
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    console.error('[agency]', (e && e.stack) || e);
    ok(res, {
      ok: false,
      task: (req.body && req.body.task) || '',
      finalOutput: 'The swarm hit an error: ' + ((e && e.message) || 'unknown'),
      agentTrace: [],
      error: (e && e.message) || 'unknown'
    });
  }
});

/* ---------------- push ---------------- */
api.get('/push/key', async (req, res) => {
  try { const v = await push.vapid(); ok(res, { publicKey: (v && v.publicKey) || null }); }
  catch (e) { fail(res, e, { publicKey: null }); }
});

api.post('/push/subscribe', async (req, res) => {
  try {
    const sub = req.body || {};
    if (!sub.endpoint) return res.status(400).json({ error: 'endpoint required' });
    const db = dbm.load();
    db.subscriptions = arr(db.subscriptions).filter(s => s.endpoint !== sub.endpoint).concat([sub]);
    await dbm.saveNow();
    ok(res, { ok: true, count: db.subscriptions.length });
  } catch (e) { fail(res, e); }
});

api.post('/push/test', async (req, res) => {
  try { ok(res, await push.pushAll({ title: 'ARIA OS', body: 'Test notification — your morning brief will arrive like this.', url: '/#/hub' })); }
  catch (e) { fail(res, e, { skipped: 'push unavailable' }); }
});

/* ---------------- automation hub: integrations, oauth, alarms, messages, media, permissions ---------------- */
api.get('/integrations', (req, res) => { try { ok(res, arr(integrations.status())); } catch (e) { fail(res, e, []); } });
api.get('/integrations/:id', (req, res) => {
  try {
    const row = integrations.one(req.params.id);
    if (!row) return res.status(404).json({ error: 'unknown integration' });
    ok(res, row);
  } catch (e) { fail(res, e); }
});
api.post('/integrations/:id/revoke', async (req, res) => {
  try { ok(res, await integrations.revoke(req.params.id)); }
  catch (e) { fail(res, e); }
});

api.get('/oauth/:provider/start', (req, res) => {
  try { ok(res, integrations.oauthStart(req.params.provider, req)); }
  catch (e) { fail(res, e); }
});
api.get('/oauth/:provider/status', (req, res) => {
  try { ok(res, integrations.oauthStatus(req.params.provider)); }
  catch (e) { fail(res, e); }
});
api.post('/oauth/:provider/revoke', async (req, res) => {
  try { ok(res, await integrations.revoke(req.params.provider)); }
  catch (e) { fail(res, e); }
});
api.get('/oauth/:provider/callback', async (req, res) => {
  try {
    const result = await integrations.oauthCallback(req.params.provider, req.query || {});
    const html = result.ok
      ? '<!DOCTYPE html><meta charset="utf-8"><title>ARIA OS</title><p>Authorized. You can close this tab.</p><script>location.replace("/#/settings")</script>'
      : `<!DOCTYPE html><meta charset="utf-8"><title>ARIA OS</title><p>Authorization failed: ${String((result && result.error) || 'unknown').replace(/[<>]/g, '')}</p>`;
    res.status(result.ok ? 200 : 400).type('html').send(html);
  } catch (e) {
    res.status(500).type('html').send('<p>OAuth error</p>');
  }
});

api.get('/alarms', (req, res) => {
  try { ok(res, alarms.list({ kind: 'alarm', status: req.query.status }).map(alarms.publicItem)); }
  catch (e) { fail(res, e, []); }
});
api.get('/alarms/due', (req, res) => {
  try { ok(res, alarms.due().map(alarms.publicItem)); }
  catch (e) { fail(res, e, []); }
});
api.post('/alarms', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await alarms.create({
      kind: 'alarm', title: b.title, body: b.body, when: b.when, fireAt: b.fireAt,
      timezone: b.timezone, recurrence: b.recurrence, source: b.source || 'api',
      confirmIfAmbiguous: b.confirmIfAmbiguous !== false, origin: 'user'
    });
    ok(res, { ...result, alarm: result.alarm ? alarms.publicItem(result.alarm) : undefined });
  } catch (e) { fail(res, e); }
});
api.post('/alarms/:id/snooze', async (req, res) => {
  try { ok(res, await alarms.snooze(req.params.id, (req.body || {}).minutes, 'alarm')); }
  catch (e) { fail(res, e); }
});
api.post('/alarms/:id/cancel', async (req, res) => {
  try { ok(res, await alarms.cancel(req.params.id, 'alarm')); }
  catch (e) { fail(res, e); }
});
api.post('/alarms/:id/fired', async (req, res) => {
  try {
    const item = await alarms.markFired(req.params.id, { browserNotification: 'client', client: (req.body || {}).client || 'browser', deviceAlarm: alarms.DEVICE_ALARM });
    ok(res, { ok: !!item, alarm: item ? alarms.publicItem(item) : null, deviceAlarm: alarms.DEVICE_ALARM });
  } catch (e) { fail(res, e); }
});
api.delete('/alarms/:id', async (req, res) => {
  try { ok(res, await alarms.cancel(req.params.id, 'alarm')); }
  catch (e) { fail(res, e); }
});

api.get('/reminders', (req, res) => {
  try { ok(res, alarms.list({ kind: 'reminder', status: req.query.status }).map(alarms.publicItem)); }
  catch (e) { fail(res, e, []); }
});
api.post('/reminders', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await alarms.create({
      kind: 'reminder', title: b.title, body: b.body || b.title, when: b.when, fireAt: b.fireAt,
      timezone: b.timezone, source: b.source || 'api', confirmIfAmbiguous: b.confirmIfAmbiguous !== false, origin: 'user'
    });
    ok(res, result);
  } catch (e) { fail(res, e); }
});
api.post('/reminders/:id/cancel', async (req, res) => {
  try { ok(res, await alarms.cancel(req.params.id, 'reminder')); }
  catch (e) { fail(res, e); }
});
api.delete('/reminders/:id', async (req, res) => {
  try { ok(res, await alarms.cancel(req.params.id, 'reminder')); }
  catch (e) { fail(res, e); }
});

api.get('/drafts', (req, res) => {
  try { ok(res, (dbm.load().drafts || []).map(messaging.publicDraft)); }
  catch (e) { fail(res, e, []); }
});
api.post('/messages/draft', async (req, res) => {
  try { ok(res, await messaging.draftMessage(req.body || {})); }
  catch (e) { fail(res, e); }
});
api.post('/messages/send', async (req, res) => {
  try { ok(res, await messaging.sendMessage({ ...(req.body || {}), origin: 'user' })); }
  catch (e) { fail(res, e); }
});
api.get('/messages/:id', (req, res) => {
  try { ok(res, messaging.readMessage(req.params.id)); }
  catch (e) { fail(res, e); }
});
api.post('/messages/:id/read', async (req, res) => {
  try { ok(res, await messaging.markRead(req.params.id)); }
  catch (e) { fail(res, e); }
});

api.get('/media', (req, res) => { try { ok(res, media.snapshot()); } catch (e) { fail(res, e); } });
api.get('/media/now', (req, res) => { try { ok(res, media.nowPlaying()); } catch (e) { fail(res, e); } });
api.post('/media/play', async (req, res) => { try { ok(res, await media.play(req.body || {})); } catch (e) { fail(res, e); } });
api.post('/media/pause', (req, res) => { try { ok(res, media.pause()); } catch (e) { fail(res, e); } });
api.post('/media/resume', (req, res) => { try { ok(res, media.resume()); } catch (e) { fail(res, e); } });
api.post('/media/skip', (req, res) => { try { ok(res, media.skip()); } catch (e) { fail(res, e); } });
api.post('/media/volume', (req, res) => { try { ok(res, media.setVolume((req.body || {}).level)); } catch (e) { fail(res, e); } });
api.post('/media/report', (req, res) => { try { ok(res, media.report(req.body || {})); } catch (e) { fail(res, e); } });

api.get('/permissions', (req, res) => { try { ok(res, permissions.publicState()); } catch (e) { fail(res, e); } });
api.post('/permissions', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.grant) await permissions.setGrant(b.grant, b.value !== false);
    if (b.grants && typeof b.grants === 'object') {
      for (const [k, v] of Object.entries(b.grants)) await permissions.setGrant(k, !!v);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'allowGroupSend')) await permissions.setAllowGroup(!!b.allowGroupSend);
    ok(res, permissions.publicState());
  } catch (e) { fail(res, e); }
});
api.get('/audit', (req, res) => {
  try { ok(res, arr(permissions.listAudit(req.query.limit))); }
  catch (e) { fail(res, e, []); }
});
api.post('/confirm', async (req, res) => {
  try {
    const id = (req.body || {}).id;
    if (!id) return res.status(400).json({ error: 'id required' });
    ok(res, await automation.confirmPending(id, { origin: 'user' }));
  } catch (e) { fail(res, e); }
});
api.post('/confirm/cancel', (req, res) => {
  try { ok(res, permissions.cancel((req.body || {}).id)); }
  catch (e) { fail(res, e); }
});

api.get('/contacts', (req, res) => {
  try { ok(res, arr((cfgm.load().contacts) || [])); }
  catch (e) { fail(res, e, []); }
});
api.post('/contacts', async (req, res) => {
  try {
    const cfg = cfgm.load();
    const list = Array.isArray(cfg.contacts) ? cfg.contacts.slice() : [];
    const b = req.body || {};
    const item = {
      id: b.id || ('ct-' + Date.now()),
      name: String(b.name || '').trim(),
      channels: { whatsapp: '', telegram: '', sms: '', email: '', ...((b.channels) || {}) }
    };
    if (!item.name) return res.status(400).json({ error: 'name required' });
    const idx = list.findIndex(c => c.id === item.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...item };
    else list.push(item);
    await cfgm.save({ contacts: list });
    ok(res, item);
  } catch (e) { fail(res, e); }
});
api.delete('/contacts/:id', async (req, res) => {
  try {
    const list = arr((cfgm.load().contacts) || []).filter(c => c.id !== req.params.id);
    await cfgm.save({ contacts: list });
    ok(res, { ok: true });
  } catch (e) { fail(res, e); }
});

/* --- Dual mount: /api/<route> AND /<route> both resolve (Vercel rewrite safety net). --- */
app.use('/api', api);
app.use(api);

/* SPA fallback for hash routes / deep links (never swallows /api or static assets). */
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET' || (req.headers.accept || '').indexOf('html') === -1) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => { if (err) next(); });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint: ' + req.originalUrl }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', (err && err.stack) || err);
  res.status(500).json({ error: (err && err.message) || 'internal error' });
});

/* Boot the async stores. Safe to call repeatedly; serverless calls it lazily per cold start. */
let initPromise = null;
async function init() {
  if (!initPromise) {
    initPromise = (async () => {
      await cfgm.init();
      await dbm.init();
      try { brain.buildIndex(); } catch (_) {}
    })().catch((e) => { console.error('[init]', e.message); });
  }
  return initPromise;
}
init();

app.init = init;
module.exports = app;
module.exports.app = app;
module.exports.init = init;
module.exports.buildState = buildState;
