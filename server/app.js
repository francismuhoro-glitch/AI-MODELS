'use strict';
/* ARIA OS — app + API. Host-agnostic:
   - Long-lived (PC/VPS/Pi): server/index.js listens and starts the in-process scheduler.
   - Serverless (Vercel): api/index.js wraps this app; cron comes from vercel.json instead. */
const express = require('express');
const path = require('path');
const cfgm = require('./config');
const dbm = require('./db');
const brain = require('./brain');
const assistant = require('./assistant');
const briefGen = require('./brief');
const connectors = require('./connectors');
const weblearn = require('./weblearn');
const doclearn = require('./doclearn');
const telegram = require('./connectors/telegram');
const { llmStatus, checkOllama } = require('./llm');
const { uid, dayKey, priorityOf, scorePriority, classifyContext } = require('./util');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* Optional single-passphrase protection — set ARIA_PASSWORD env var to lock the dashboard + API.
   Accepted credentials, in order: X-ARIA-Key header, aria_key cookie, ?key= query param.

   Why the cookie matters: a browser *navigation* (typing the URL, tapping the home-screen icon,
   a service-worker refresh) cannot attach a custom header, so a key living only in localStorage
   could never unlock the document itself — the unlock form saved the key, reloaded, got the
   unlock form again, and the dashboard reported "unauthorized — send X-ARIA-Key header".
   The cookie rides along with every navigation, which breaks that deadlock. */
const AUTH_COOKIE = 'aria_key';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const val = part.slice(eq + 1).trim();
    try { return decodeURIComponent(val); } catch (_) { return val; }
  }
  return null;
}

function setAuthCookie(req, res, value) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.cookie(AUTH_COOKIE, value, { path: '/', maxAge: COOKIE_MAX_AGE, sameSite: 'lax', httpOnly: false, secure });
}

/* Unlock page — stores the passphrase in BOTH places: the cookie (so navigations authenticate)
   and localStorage (so fetch() keeps sending X-ARIA-Key). It also self-heals installs that were
   unlocked by an older build: a key stranded in localStorage is mirrored into the cookie once. */
const UNLOCK_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARIA OS — unlock</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0e14;color:#e8eef7;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#131a26;border:1px solid #223047;padding:30px;border-radius:16px;width:min(340px,90vw);text-align:center}h1{font-size:18px;margin-bottom:4px}p{color:#8b9bb4;font-size:12.5px;margin:0 0 18px}input{width:100%;box-sizing:border-box;background:#0f141d;border:1px solid #2c3d5a;color:#e8eef7;border-radius:10px;padding:11px 13px;font-size:15px;outline:none}button{width:100%;margin-top:12px;background:linear-gradient(135deg,#5b8cff,#7c5bff);border:0;color:#fff;border-radius:10px;padding:11px;font-size:15px;font-weight:700;cursor:pointer}</style></head><body>
<form id="unlock" autocomplete="on"><h1>🧠 ARIA OS</h1><p>enter your passphrase</p><input name="k" type="password" autofocus autocomplete="current-password"><button type="submit">Unlock</button></form>
<script>
(function () {
  var LS = 'aria.key';
  function save(v) {
    try { localStorage.setItem(LS, v); } catch (e) {}
    document.cookie = 'aria_key=' + encodeURIComponent(v) + '; path=/; max-age=31536000; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '');
  }
  document.getElementById('unlock').onsubmit = function () {
    var v = this.k.value; if (!v) return false;
    save(v); location.reload(); return false;
  };
  /* self-heal: unlocked by an older build → key is in localStorage but not in the cookie */
  try {
    var saved = localStorage.getItem(LS);
    if (saved && document.cookie.indexOf('aria_key=') === -1 && !sessionStorage.getItem('aria.rehydrate')) {
      sessionStorage.setItem('aria.rehydrate', '1');
      save(saved); location.reload();
    }
  } catch (e) {}
  /* drop a stale service worker that may be serving a cached unlock shell */
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.update(); }); }).catch(function () {});
})();
</script>
</body></html>`;

app.use((req, res, next) => {
  const pass = process.env.ARIA_PASSWORD;
  if (!pass) return next();
  const cookieKey = readCookie(req, AUTH_COOKIE);
  const key = req.headers['x-aria-key'] || cookieKey || req.query.key;
  if (key === pass) {
    // Unlocking via ?key= (shared link, iOS Shortcut) also plants the cookie so navigations stick.
    if (cookieKey !== pass && req.query.key === pass) setAuthCookie(req, res, pass);
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized — send X-ARIA-Key header, aria_key cookie (or ?key=)' });
  const isDocument = req.accepts('html') && !/\.[a-z0-9]+$/i.test(req.path);
  if (isDocument) {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('X-ARIA-Locked', '1'); // lets the service worker refuse to cache this page as the app shell
    return res.type('html').send(UNLOCK_PAGE);
  }
  return next();
});

/* Ensure the backing store is loaded before any request touches data */
app.use(async (req, res, next) => { try { await dbm.init(); next(); } catch (e) { res.status(500).json({ error: `storage: ${e.message}` }); } });

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
app.get('/api/events', (req, res) => { try { const db = dbm.load(); return res.json(db.events || []); } catch(e){ return res.json([]); }
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

/* Document & File Upload Endpoint */
app.post('/api/notes/upload', async (req, res) => {
  try {
    const { filename, content, base64, mimeType } = req.body || {};
    if (!filename || (!content && !base64)) return res.status(400).json({ error: 'filename and content/base64 required' });
    const buffer = base64 ? Buffer.from(base64, 'base64') : Buffer.from(content, 'utf8');
    const note = await doclearn.ingestDocument(filename, buffer, mimeType);
    res.json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Telegram Connector Config & Test */
app.post('/api/connectors/telegram/setup', async (req, res) => {
  try {
    const { token, allowedChatId, enabled } = req.body || {};
    const cfg = await cfgm.save({ telegram: { token, allowedChatId, enabled: !!enabled } });
    if (enabled && token) telegram.startTelegram();
    else telegram.stopTelegram();
    res.json({ ok: true, telegram: cfg.telegram });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notes', async (req, res) => {
  const { title, content, tags } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const note = brain.ingestNote({ title: title || snippet(content, 60), content, source: 'manual', tags: tags || ['captured'] });
  brain.buildIndex();
  await dbm.saveNow();
  res.json(note);
});
/* Learn from a website — reads a page and saves its text into the second brain */
app.post('/api/notes/from-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    let parsed;
    try { parsed = new URL(String(url).trim()); } catch (_) { return res.status(400).json({ error: 'that does not look like a valid URL' }); }
    if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'only https URLs are supported' });
    const note = await weblearn.learnFromUrl(url);
    res.json({ ok: true, note });
  } catch (e) {
    res.status(502).json({ error: e.message || 'could not read that page' });
  }
});
app.delete('/api/notes/:id', async (req, res) => {
  const db = dbm.load(); db.notes = db.notes.filter(n => n.id !== req.params.id); await dbm.saveNow(); brain.buildIndex(); res.json({ ok: true });
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
app.post('/api/assistant/reset', async (req, res) => {
  const db = dbm.load(); db.chats = []; await dbm.saveNow(); res.json({ ok: true });
});
app.get('/api/ai/status', async (req, res) => { await checkOllama(); res.json(llmStatus()); });

/* ---------- Settings & connectors ---------- */
app.get('/api/settings', (req, res) => {
  const cfg = cfgm.load();
  const safe = structuredClone(cfg);
  if (safe.smtp) safe.smtp.pass = safe.smtp.pass ? '********' : '';
  res.json(safe);
});
app.post('/api/settings', async (req, res) => {
  try {
    const patch = req.body || {};
    if (patch.smtp && patch.smtp.pass === '********') delete patch.smtp.pass;
    const cfg = await cfgm.save(patch);
    const rearm = app.get('rearm'); if (rearm) rearm(); // re-arm in-process schedules (long-lived mode)
    res.json({ ok: true, wakeTime: cfg.wakeTime, timezone: cfg.owner.timezone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/connectors', (req, res) => res.json(connectors.status()));
app.post('/api/connectors/:id', async (req, res) => {
  const id = req.params.id;
  const patch = { connectors: { [id]: { enabled: !!req.body.enabled, ...req.body.config || {} } } };
  await cfgm.save(patch); res.json({ ok: true, status: connectors.status() });
});
app.post('/api/sync', async (req, res) => {
  try { res.json(await connectors.syncAll()); } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Demo data purge ----------
   Deletes every record the demo connector seeded, across all collections, rebuilds the
   brain index so fake knowledge is gone too, and marks seeding complete so a later boot
   never re-seeds.
   Matching: ids prefixed "demo-" (the seeded rows themselves) plus the notes/tasks the
   brain auto-derived from them (ids embed the demo reference, e.g. "note-email-demo-em-…",
   "task-message-demo-msg-…"). Real connectors can never produce those patterns. */
app.post('/api/demo/purge', async (req, res) => {
  try {
    const db = dbm.load();
    const isDemoRow = (item) => {
      const id = String(item.id || '');
      return id.startsWith('demo-') || /^(?:task|note)-(?:email|msg|message)-demo-/.test(id);
    };
    const removed = {};
    for (const col of ['emails', 'messages', 'events', 'notes', 'tasks']) {
      const before = db[col].length;
      db[col] = db[col].filter(item => !isDemoRow(item));
      removed[col] = before - db[col].length;
    }
    db.meta.seeded = true;
    brain.buildIndex();
    await dbm.saveNow();
    res.json({ ok: true, removed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Cron (Vercel scheduled; harmless in long-lived mode) ---------- */
app.all('/api/cron/morning', async (req, res) => {
  try {
    if (process.env.CRON_SECRET && req.headers['x-cron-secret'] !== process.env.CRON_SECRET)
      return res.status(401).json({ error: 'forbidden' });
    await connectors.syncAll();
    const brief = await briefGen.generate({ trigger: 'scheduled' });
    res.json({ ok: true, date: brief.date, hot: brief.meta.hot, push: brief.pushStatus || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Universal ingest (iOS Shortcuts, Zapier, n8n, scripts…) ---------- */
app.post('/api/ingest', async (req, res) => {
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
  await dbm.saveNow();
  res.json({ ok: true });
});
/* WhatsApp Cloud API webhook endpoint */
app.get('/api/ingest/whatsapp', (req, res) => res.send(req.query['hub.challenge'] || 'ok'));
app.post('/api/ingest/whatsapp', async (req, res) => {
  try {
    for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const m of value.messages || []) {
        const ms = { id: `wa-${m.id}`, source: 'whatsapp', channel: 'WhatsApp inbound', from: m.from || 'unknown', text: m.text?.body || '', sentAt: +(m.timestamp || Date.now() / 1000) * 1000, read: false };
        ms.priorityScore = scorePriority(ms); ms.priority = priorityOf(ms.priorityScore); ms.context = classifyContext(ms);
        dbm.upsert('messages', ms);
      }
    }
    await dbm.saveNow();
  } catch (_) {}
  res.json({ ok: true });
});

/* ---------- Push notifications ---------- */
app.get('/api/push/key', async (req, res) => {
  const { vapid } = require('./push');
  const v = await vapid();
  res.json({ publicKey: v ? v.publicKey : null });
});
app.post('/api/push/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const db = dbm.load();
  db.subscriptions = db.subscriptions || [];
  const i = db.subscriptions.findIndex(s => s.endpoint === sub.endpoint);
  if (i >= 0) db.subscriptions[i] = sub; else db.subscriptions.push(sub);
  await dbm.saveNow();
  res.json({ ok: true, total: db.subscriptions.length });
});
app.post('/api/push/test', async (req, res) => {
  try { res.json(await require('./push').pushAll({ title: '🔔 ARIA OS test', body: 'Notifications are working — your brief arrives every morning at ' + cfgm.load().wakeTime + '.', url: '/#/briefs' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'ARIA OS', ts: Date.now() }));

/* ---------- One-time init ----------
   Demo seeding is OPT-IN: a fresh install starts empty unless ARIA_DEMO=1 is set.
   (Old builds seeded demo data whenever db.meta.seeded was false; that silently
   flooded production deploys with fake mail.) */
async function init() {
  await dbm.init();
  const db = dbm.load();
  if (!db.meta.seeded) {
    if (process.env.ARIA_DEMO === '1') {
      await connectors.syncAll();
      console.log('[boot] ARIA_DEMO=1 — demo data seeded…');
    } else {
      console.log('[boot] first boot — starting empty (set ARIA_DEMO=1 to seed demo data)');
    }
    db.meta.seeded = true;
    await dbm.saveNow();
  }
  return { ok: true };
}

module.exports = { app, init };
