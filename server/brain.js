'use strict';
/* SECOND BRAIN — an ever-evolving library of context for your day job & business.
   - autoGrow(): learns from every email, message and brief that flows through the OS
   - extractTasks(): turns asks into action items
   - search(): HYBRID retrieval — BM25 lexical scoring blended 50/50 with cosine similarity
     over embeddings, so paraphrased questions ("who do I know that sells cement?") still hit
     the right note. Without a reachable embedding backend the semantic half is simply empty
     and search() degrades to pure BM25 (identical to the old behaviour).
   - contextPack(): builds the context the executive assistant reasons over */
const dbm = require('./db');
const { uid, slug, dayKey, dayKeyAdd, timeStr, tokenize, extractTopics, extractEntities, snippet } = require('./util');
const { getEmbedding, cosineSimilarity, embeddingBackendLive } = require('./embeddings');

/* Semantic weighting: half lexical, half meaning. Both sides are normalised to 0..1 first. */
const BLEND_WEIGHTS = { lexical: 0.5, semantic: 0.5 };
/* A note with no lexical overlap at all still surfaces when the vectors are this close. */
const SEMANTIC_ONLY_MIN = 0.55;
const EMBED_MAX_NOTES = 300;      // keep the persisted document small
const EMBED_COOLDOWN_MS = 5 * 60_000;

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

/* ---------- Hybrid search: BM25 (lexical) + embeddings (semantic) ---------- */
let index = null, indexBuiltAt = 0;
let lastEmbedPrimeAt = 0;
const queryVecs = new Map();      // small cache: query text → vector

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

  /* Cached note embeddings (note.embedding) — written lazily by primeEmbeddings(), and only
     when an embedding backend is reachable, so offline this map stays empty. */
  const docVecs = new Map();
  for (const n of db.find('notes')) {
    if (Array.isArray(n.embedding) && n.embedding.length) docVecs.set(n.id, n.embedding);
  }

  index = { docs, docTokens, df, avgLen, N: docs.length, docVecs };
  indexBuiltAt = Date.now();
  return index;
}

function ensureIndex() {
  if (!index || Date.now() - indexBuiltAt > 60_000) buildIndex();
  return index;
}

/* Pure BM25 pass — unchanged scoring, so every existing consumer keeps its thresholds. */
function bm25Search(query, limit = 24) {
  const { docs, docTokens, df, avgLen, N } = ensureIndex();
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

/* Normalised blend of one lexical and one semantic evidence value (both 0..1). */
function blendScore(bm25Norm, cosine, weights = BLEND_WEIGHTS) {
  const lex = Math.max(0, Math.min(1, Number(bm25Norm) || 0));
  const sem = Math.max(0, Math.min(1, Number(cosine) || 0));
  return Math.round((weights.lexical * lex + weights.semantic * sem) * 1000) / 1000;
}

/**
 * Blend a BM25 hit list with cosine similarity against a query vector. Pure + injectable
 * (`docVectors` is a Map refId → vector) so the blend is unit-testable with fallbackVector()
 * and no Ollama. `score` stays the raw BM25 value — existing thresholds depend on it — while
 * `blended` is the new ranking key and `semantic` the cosine evidence.
 */
function blendResults(bm25Hits, queryVector, docVectors, weights = BLEND_WEIGHTS) {
  const hits = Array.isArray(bm25Hits) ? bm25Hits : [];
  const vecs = docVectors instanceof Map ? docVectors : new Map(Object.entries(docVectors || {}));
  const maxBm25 = hits.reduce((m, h) => Math.max(m, Number(h.score) || 0), 0) || 1;
  const seen = new Set();
  const out = hits.map(h => {
    const v = vecs.get(h.refId) || vecs.get(h.id);
    const cos = v && queryVector ? cosineSimilarity(queryVector, v) : 0;
    seen.add(h.refId);
    return {
      ...h, bm25: h.score, semantic: Math.round(Math.max(0, cos) * 1000) / 1000,
      blended: blendScore((Number(h.score) || 0) / maxBm25, cos, weights)
    };
  });
  /* Meaning-only rescues: a note with no shared words but a strong vector match. */
  if (queryVector && vecs.size) {
    for (const [refId, v] of vecs) {
      if (seen.has(refId)) continue;
      const cos = cosineSimilarity(queryVector, v);
      if (cos < SEMANTIC_ONLY_MIN) continue;
      const doc = ensureIndex().docs.find(d => d.refId === refId);
      if (!doc) continue;
      out.push({
        score: 0, bm25: 0, semantic: Math.round(cos * 1000) / 1000, blended: blendScore(0, cos, weights),
        kind: doc.kind, title: doc.title, snippet: snippet(doc.text, 220), ts: doc.ts, tags: doc.tags, refId: doc.refId
      });
    }
  }
  return out.sort((a, b) => b.blended - a.blended || b.score - a.score);
}

/* The query vector, cached — one embedding per distinct question per process. */
function cachedQueryVector(query) { return queryVecs.get(String(query || '').toLowerCase().trim()) || null; }

async function queryVectorFor(query, opts = {}) {
  const key = String(query || '').toLowerCase().trim();
  if (!key) return null;
  if (queryVecs.has(key)) return queryVecs.get(key);
  /* offlineOnly: do not even try (and never persist a hash vector) without a real backend. */
  if (opts.offlineOnly && !(await embeddingBackendLive())) return null;
  const v = await getEmbedding(key, { fallback: opts.fallback !== false });
  if (v && v.length) {
    queryVecs.set(key, v);
    if (queryVecs.size > 60) queryVecs.delete(queryVecs.keys().next().value);   // cap the cache
  }
  return v || null;
}

/**
 * Embed every note that has no vector yet. A silent no-op when no embedding backend is
 * reachable (offline stays pure BM25) and rate-limited so it never storms the daemon.
 */
async function primeEmbeddings(opts = {}) {
  const force = !!opts.force;
  if (!force && Date.now() - lastEmbedPrimeAt < EMBED_COOLDOWN_MS) return { primed: 0, skipped: true };
  lastEmbedPrimeAt = Date.now();
  let live = false;
  try { live = !!(await embeddingBackendLive()); } catch (_) { live = false; }
  if (!live && !force) return { primed: 0, live: false };
  const db = dbm.load();
  const have = () => db.find('notes', n => Array.isArray(n.embedding) && n.embedding.length).length;
  const pending = db.find('notes', n => !Array.isArray(n.embedding) || !n.embedding.length)
    .slice(0, Math.min(opts.limit || 24, Math.max(0, EMBED_MAX_NOTES - have())));
  let primed = 0;
  for (const n of pending) {
    try {
      /* Real embeddings only: the TF-IDF fallbackVector stays a search-time safety net and is
         never persisted onto a note (that would bloat the store with meaningless numbers). */
      const v = await getEmbedding(`${n.title}\n${n.content}`, { fallback: false });
      if (Array.isArray(v) && v.length) {
        n.embedding = v.map(x => Math.round(x * 1e5) / 1e5);
        n.embeddedAt = Date.now();
        db.upsert('notes', n);
        primed++;
      }
    } catch (_) { /* one bad note never stops the pass */ }
  }
  if (primed) { buildIndex(); dbm.save(); }
  return { primed, live };
}

/**
 * Search the brain. Synchronous: blends with whatever embeddings are already cached, so
 * offline (no vectors at all) it is exactly the old BM25 behaviour with semantic = 0.
 */
function search(query, limit = 8) {
  const hits = bm25Search(query, Math.max(limit * 3, 24));
  const qv = cachedQueryVector(query);
  const dv = (index && index.docVecs) || new Map();
  if (!qv || !dv.size) {
    const max = hits.reduce((m, h) => Math.max(m, h.score), 0) || 1;
    return hits.slice(0, limit).map(h => ({ ...h, bm25: h.score, semantic: 0, blended: blendScore(h.score / max, 0) }));
  }
  return blendResults(hits, qv, dv).slice(0, limit);
}

/**
 * Injectable hybrid search — the unit-testable entry point. Pass `queryVector` and
 * `docVectors` to exercise the blend deterministically (e.g. with embeddings.fallbackVector).
 */
function blendSearch(query, opts = {}) {
  const limit = opts.limit || 8;
  const hits = bm25Search(query, Math.max(limit * 3, 24));
  const qv = opts.queryVector || cachedQueryVector(query);
  const dv = opts.docVectors || (index && index.docVecs) || new Map();
  if (!qv || !dv || !dv.size) {
    const max = hits.reduce((m, h) => Math.max(m, h.score), 0) || 1;
    return hits.slice(0, limit).map(h => ({ ...h, bm25: h.score, semantic: 0, blended: blendScore(h.score / max, 0) }));
  }
  return blendResults(hits, qv, dv, opts.weights).slice(0, limit);
}

/* Async search: primes note embeddings + the query vector first (only when a backend is
   live), then blends. This is what makes paraphrased questions hit the right note. */
async function searchAsync(query, limit = 8) {
  try {
    await primeEmbeddings();
    await queryVectorFor(query, { offlineOnly: true, fallback: false });
  } catch (_) {}
  return search(query, limit);
}

/* ---------- Context pack for the assistant ----------
   Everything ARIA reasons over in one prompt: the rolling conversation summary, today +
   upcoming, tomorrow on its own (the day people actually plan against), the last 3 turns,
   priority emails/messages, open tasks and the relevant slice of the second brain.
   Synchronous and LLM-free by design — it must work with no model reachable at all. */
function contextPack(query = '') {
  const db = dbm.load();
  const cfg = require('./config').load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const today = dayKey(Date.now(), tz);
  const tomorrow = dayKeyAdd(today, 1);
  const fmtEvent = (e) => `- ${timeStr(e.start, tz)}–${timeStr(e.end || e.start + 36e5, tz)} [${e.calendar || (e.context === 'business' ? 'Business' : 'Work')}] ${e.title}${e.location ? ` @ ${e.location}` : ''}`;
  const events = db.find('events', e => dayKey(e.start, tz) >= today)
    .sort((a, b) => a.start - b.start).slice(0, 10)
    .map(fmtEvent);
  const tomorrowEvents = db.find('events', e => dayKey(e.start, tz) === tomorrow)
    .sort((a, b) => a.start - b.start).slice(0, 8)
    .map(fmtEvent);
  const prioEmails = db.find('emails', e => e.priority === 'high' || e.priority === 'medium').slice(0, 6)
    .map(e => `- (${e.priority}) ${e.subject} — from ${e.fromName || e.from}`);
  const prioMsgs = db.find('messages', m => m.priority === 'high').slice(0, 6)
    .map(m => `- [${m.channel}] ${m.from}: ${snippet(m.text, 100)}`);
  const tasks = db.find('tasks', t => !t.done).slice(0, 8).map(t => `- ${t.title}${t.due ? ` (due ${new Date(t.due).toDateString()})` : ''}`);
  const brainHits = query ? search(query, 6) : search((extractTopics(prioEmails.join(' ') + ' ' + events.join(' '), 3).join(' ')) || 'business work', 4);

  /* Conversation memory that outlives the 10-turn window: the rolling summary written every
     12 turns (db.meta.conversation.summary) plus the last 3 raw turns. */
  const conv = (db.meta && db.meta.conversation) || {};
  const turns = (db.chats || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const recent = turns.slice(0, Math.max(0, turns.length - 1)).slice(-3)
    .map(c => `- ${c.role === 'assistant' ? 'ARIA' : 'User'}: ${snippet(String(c.content || '').replace(/[*#`>]/g, '').replace(/\s+/g, ' '), 140)}`);

  return [
    conv.summary ? `== CONVERSATION SO FAR (rolling summary) ==\n${conv.summary}` : null,
    `== TODAY & UPCOMING ==\n${events.join('\n') || 'No events.'}`,
    `== TOMORROW (${tomorrow}) ==\n${tomorrowEvents.join('\n') || 'Nothing scheduled yet.'}`,
    `== LAST 3 TURNS ==\n${recent.join('\n') || 'This is the first turn.'}`,
    `== PRIORITY EMAILS ==\n${prioEmails.join('\n') || 'None.'}`,
    `== PRIORITY MESSAGES ==\n${prioMsgs.join('\n') || 'None.'}`,
    `== OPEN ACTION ITEMS ==\n${tasks.join('\n') || 'None.'}`,
    `== SECOND BRAIN (relevant knowledge) ==\n${brainHits.map(h => `- [${h.kind}] ${h.title}: ${snippet(h.snippet, 120)}${h.semantic >= 0.5 ? ' (semantic match)' : ''}`).join('\n') || 'Empty.'}`
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  ingestNote, autoGrow, search, searchAsync, blendSearch, blendResults, blendScore,
  bm25Search, primeEmbeddings, queryVectorFor, buildIndex, contextPack, extractTopics, looksLikeTask,
  BLEND_WEIGHTS, SEMANTIC_ONLY_MIN
};
