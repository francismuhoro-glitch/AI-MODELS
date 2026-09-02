'use strict';
/* SECOND BRAIN — an ever-evolving library of context for your day job & business.
   - autoGrow(): learns from every email, message and brief that flows through the OS
   - extractTasks(): turns asks into action items
   - search(): BM25 full-text retrieval across everything
   - contextPack(): builds the context the executive assistant reasons over */
const dbm = require('./db');
const { uid, slug, dayKey, tokenize, extractTopics, extractEntities, snippet } = require('./util');

/* ---------- Note ingestion ---------- */
function ingestNote({ title, content, source = 'manual', tags = [], ts = Date.now(), kind = 'note', refId = null }) {
  const db = dbm.load();
  const id = refId ? `note-${slug(source)}-${slug(title)}-${slug(String(refId))}`.slice(0, 90) : uid('note');
  const existing = db.one('notes', n => n.id === id);
  const note = {
    id, title: String(title).slice(0, 160), content: String(content), source, tags, kind,
    topics: extractTopics(`${title} ${content}`, 6), entities: extractEntities(`${title} ${content}`),
    createdAt: existing ? existing.createdAt : ts, updatedAt: ts, refId
  };
  db.upsert('notes', note);
  return note;
}

/* ---------- Task extraction ---------- */
const TASK_PATTERNS = [
  /\b(please send|kindly send|send (?:me |us )?the?)\b/i,
  /\b(follow[- ]?up|follow up)\b/i,
  /\b(can you|could you|need you to|let me know|confirm|reply|respond|rsvp)\b/i,
  /\b(by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|eod|thu|fri))\b/i,
  /\b(deadline|due|submit|review|approve|sign)\b/i,
  /\b(invoice|quotation|quote|payment reminder)\b/i
];
function looksLikeTask(text) { return TASK_PATTERNS.some(r => r.test(text)); }

function taskFromItem(kind, item) {
  const title = kind === 'email'
    ? `Follow up on email: ${item.subject}`.slice(0, 120)
    : `${item.channel ? `[${item.channel}] ` : ''}Action from ${item.from}: ${snippet(item.text, 90)}`;
  const id = `task-${slug(sourceKey(kind, item))}`;
  const due = guessDue(`${item.subject || ''} ${item.text || item.body || ''}`);
  return { id, title, due, source: kind === 'email' ? `email:${item.source}` : `${item.source}:${item.channel || ''}`, refId: item.id, done: false, priority: item.priority || 'medium', createdAt: Date.now() };
}
const sourceKey = (kind, item) => `${kind}-${item.id}`;

function guessDue(text) {
  const t = text.toLowerCase();
  const now = new Date();
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  if (/\btoday|eod\b/.test(t)) return endOfDay(now);
  const tom = new Date(now.getTime() + 864e5); if (/\btomorrow\b/.test(t)) return endOfDay(tom);
  for (const [name, d] of Object.entries(days)) if (t.includes(`by ${name}`)) { const dt = new Date(now); const delta = (d - dt.getDay() + 7) % 7 || 7; dt.setDate(dt.getDate() + delta); return endOfDay(dt); }
  if (/friday|thu\b/.test(t) && /\bdue|deadline|before\b/.test(t)) { const dt = new Date(now); const delta = (5 - dt.getDay() + 7) % 7 || 7; dt.setDate(dt.getDate() + delta); return endOfDay(dt); }
  return null;
}
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 0); return x.getTime(); };

/* ---------- Auto-growth ---------- */
let lastGrowAt = 0;
function autoGrow() {
  const db = dbm.load();
  const since = lastGrowAt || Date.now() - 24 * 36e5;
  let grown = 0;

  // 1. High/medium priority emails become memory notes
  for (const em of db.find('emails', e => !e.brainedAt && e.priority !== 'low')) {
    ingestNote({
      title: `Email — ${em.subject}`, refId: em.id, source: `email:${em.source}`, kind: 'email',
      tags: [em.context || 'work', em.priority || 'medium'],
      content: `From: ${em.fromName} <${em.from}>\nReceived: ${new Date(em.receivedAt).toISOString()}\nPriority: ${em.priority}\n\n${em.body}`
    });
    em.brainedAt = Date.now(); db.upsert('emails', em); grown++;
    if (looksLikeTask(`${em.subject} ${em.body}`)) db.upsert('tasks', taskFromItem('email', em));
  }

  // 2. Priority messages become memory notes
  for (const ms of db.find('messages', m => !m.brainedAt && m.priority !== 'low')) {
    ingestNote({
      title: `Message — ${ms.channel} (${ms.from})`, refId: ms.id, source: `msg:${ms.source}`, kind: 'message',
      tags: [ms.context || 'work', ms.priority || 'medium'],
      content: `Channel: ${ms.channel}\nFrom: ${ms.from}\nAt: ${new Date(ms.sentAt).toISOString()}\n\n${ms.text}`
    });
    ms.brainedAt = Date.now(); db.upsert('messages', ms); grown++;
    if (looksLikeTask(ms.text)) db.upsert('tasks', taskFromItem('message', ms));
  }

  // 3. Rolling "day log" note — the brain's daily memory
  const today = dayKey(Date.now(), 'Africa/Nairobi');
  const todaysEvents = db.find('events', e => dayKey(e.start, 'Africa/Nairobi') === today);
  const todaysEmails = db.find('emails', e => dayKey(e.receivedAt, 'Africa/Nairobi') === today);
  const todaysMsgs = db.find('messages', m => dayKey(m.sentAt, 'Africa/Nairobi') === today);
  if (todaysEvents.length || todaysEmails.length || todaysMsgs.length) {
    ingestNote({
      title: `Day log — ${today}`, refId: today, source: 'system', kind: 'daylog',
      tags: ['daylog'],
      content: [
        `Events (${todaysEvents.length}): ${todaysEvents.map(e => `${new Date(e.start).toISOString().slice(11, 16)} ${e.title}`).join('; ') || 'none'}`,
        `Emails (${todaysEmails.length}): ${todaysEmails.map(e => e.subject).join('; ') || 'none'}`,
        `Messages (${todaysMsgs.length}): ${todaysMsgs.map(m => `${m.from}: ${snippet(m.text, 60)}`).join('; ') || 'none'}`
      ].join('\n')
    });
  }
  lastGrowAt = Date.now();
  dbm.save();
  return { grown };
}

/* ---------- BM25 search ---------- */
let index = null, indexBuiltAt = 0;
function buildIndex() {
  const db = dbm.load();
  const docs = [];
  for (const n of db.find('notes')) docs.push({ id: n.id, kind: 'note', title: n.title, text: `${n.title}\n${n.content}`, tags: n.tags, ts: n.updatedAt, refId: n.id });
  for (const em of db.find('emails')) docs.push({ id: `search-${em.id}`, kind: 'email', title: `Email: ${em.subject}`, text: `${em.subject}\n${em.body || em.snippet}`, tags: [em.source], ts: em.receivedAt, refId: em.id });
  for (const ms of db.find('messages')) docs.push({ id: `search-${ms.id}`, kind: 'message', title: `Message: ${ms.channel} — ${ms.from}`, text: ms.text, tags: [ms.source], ts: ms.sentAt, refId: ms.id });
  for (const ev of db.find('events')) docs.push({ id: `search-${ev.id}`, kind: 'event', title: `Event: ${ev.title}`, text: `${ev.title} ${ev.location} ${(ev.attendees || []).join(' ')}`, tags: [ev.calendar], ts: ev.start, refId: ev.id });
  for (const b of db.find('briefs')) docs.push({ id: `search-${b.id}`, kind: 'brief', title: `Morning brief ${b.date}`, text: b.markdown, tags: ['brief'], ts: b.generatedAt, refId: b.id });

  const docTokens = docs.map(d => tokenize(d.text));
  const df = {};
  for (const toks of docTokens) for (const t of new Set(toks)) df[t] = (df[t] || 0) + 1;
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, docs.length);
  index = { docs, docTokens, df, avgLen, N: docs.length };
  indexBuiltAt = Date.now();
  return index;
}

function search(query, limit = 8) {
  if (!index || Date.now() - indexBuiltAt > 60_000) buildIndex();
  const { docs, docTokens, df, avgLen, N } = index;
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const k1 = 1.5, b = 0.75;
  const scored = [];
  for (let i = 0; i < docs.length; i++) {
    const toks = docTokens[i];
    if (!toks.length) continue;
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const q of qTokens) {
      if (!tf[q]) { // partial word match fallback
        const part = Object.keys(tf).find(t => t.startsWith(q) || q.startsWith(t));
        if (!part) continue;
        score += bm25(tf[part], df[part] || 0, N, toks.length, avgLen, k1, b) * 0.6;
      } else {
        score += bm25(tf[q], df[q] || 0, N, toks.length, avgLen, k1, b);
      }
    }
    if (score > 0) scored.push({ score, doc: docs[i] });
  }
  return scored.sort((a, b2) => b2.score - a.score).slice(0, limit).map(s => ({
    score: Math.round(s.score * 100) / 100, kind: s.doc.kind, title: s.doc.title,
    snippet: snippet(s.doc.text, 220), ts: s.doc.ts, tags: s.doc.tags, refId: s.doc.refId
  }));
}
function bm25(tf, df, N, len, avgLen, k1, b) {
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  return idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgLen)));
}

/* ---------- Context pack for the assistant ---------- */
function contextPack(query = '') {
  const db = dbm.load();
  const cfg = require('./config').load();
  const today = dayKey(Date.now(), cfg.owner.timezone);
  const events = db.find('events', e => dayKey(e.start, cfg.owner.timezone) >= today)
    .sort((a, b) => a.start - b.start).slice(0, 10)
    .map(e => `- ${new Date(e.start).toISOString().slice(11, 16)}–${new Date(e.end).toISOString().slice(11, 16)} [${e.calendar}] ${e.title}${e.location ? ` @ ${e.location}` : ''}`);
  const prioEmails = db.find('emails', e => e.priority === 'high' || e.priority === 'medium').slice(0, 6)
    .map(e => `- (${e.priority}) ${e.subject} — from ${e.fromName || e.from}`);
  const prioMsgs = db.find('messages', m => m.priority === 'high').slice(0, 6)
    .map(m => `- [${m.channel}] ${m.from}: ${snippet(m.text, 100)}`);
  const tasks = db.find('tasks', t => !t.done).slice(0, 8).map(t => `- ${t.title}${t.due ? ` (due ${new Date(t.due).toDateString()})` : ''}`);
  const brainHits = query ? search(query, 6) : search((extractTopics(prioEmails.join(' ') + ' ' + events.join(' '), 3).join(' ')) || 'business work', 4);

  return [
    `== TODAY & UPCOMING ==\n${events.join('\n') || 'No events.'}`,
    `== PRIORITY EMAILS ==\n${prioEmails.join('\n') || 'None.'}`,
    `== PRIORITY MESSAGES ==\n${prioMsgs.join('\n') || 'None.'}`,
    `== OPEN ACTION ITEMS ==\n${tasks.join('\n') || 'None.'}`,
    `== SECOND BRAIN (relevant knowledge) ==\n${brainHits.map(h => `- [${h.kind}] ${h.title}: ${snippet(h.snippet, 120)}`).join('\n') || 'Empty.'}`
  ].join('\n\n');
}

module.exports = { ingestNote, autoGrow, search, buildIndex, contextPack, extractTopics, looksLikeTask };
