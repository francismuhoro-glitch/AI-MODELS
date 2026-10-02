'use strict';
/* ARIA MEMORY — durable, semantic memory in Supabase (pgvector) with an offline fallback.
   ═══════════════════════════════════════════════════════════════════════════════════════
   Storage (chosen automatically, same rule as store.js):
     • Supabase  — when SUPABASE_URL + SUPABASE_SERVICE_KEY are set AND the aria_memory
                   table exists (see supabase/migrations/*_aria_memory.sql). Rows are real
                   Postgres rows with a vector(768) embedding; retrieval goes through the
                   match_aria_memories() RPC.
     • local     — anything else (no keys, no table yet, offline laptop): the same shape is
                   kept inside db.memories in the JSON state document, with the identical
                   hybrid ranking. Nothing breaks without Supabase or Ollama.
   Retrieval is a genuine HYBRID: BM25 lexical scoring (JS, over a candidate set) blended
   50/50 with cosine similarity (from the RPC for Supabase rows; computed in JS for local
   rows). Same weights as the second brain.
   Guarantees
     • Never stores secrets: content is redacted through secrets.redactText() and truncated.
       (Phase 3 adds the full "no PINs/tokens/card numbers/full message bodies" filter.)
     • last_accessed is bumped for every memory that is actually retrieved.
     • Expired rows (expires_at < now) are excluded from retrieval everywhere.
*/
const dbm = require('./db');
const secrets = require('./secrets');
const { uid, tokenize } = require('./util');
const { getEmbedding, embedDim, cosineSimilarity, isVector, fallbackVector } = require('./embeddings');

const TABLE = 'aria_memory';
const LOCAL_COLLECTION = 'memories';
const LOCAL_CAP = 500;                 // keep the JSON fallback document small
const MAX_CONTENT = 1000;
const DEFAULT_LIMIT = 6;
const CANDIDATE_FACTOR = 4;            // candidate set = limit × this (min 24) before re-ranking
/* Same blend as the second brain: half meaning, half exact terms. */
const BLEND_WEIGHTS = { lexical: 0.5, semantic: 0.5 };
const KINDS = new Set(['fact', 'preference', 'correction', 'summary']);

/* Injectable transport (tests verify the Supabase path with no network). */
let fetchImpl = (...a) => fetch(...a);
function _setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

function supa() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
  return { url, key, configured: !!(url && key) };
}

/* Does the aria_memory table answer? Probed once per process (a 404 means "not installed yet"). */
let tableState = { ok: null, checkedAt: 0 };
async function tableAvailable({ force = false } = {}) {
  const { url, key, configured } = supa();
  if (!configured) return false;
  if (!force && tableState.ok !== null && Date.now() - tableState.checkedAt < 300_000) return tableState.ok;
  try {
    const res = await fetchImpl(`${url}/rest/v1/${TABLE}?select=id&limit=1`, { headers: headers(key) });
    tableState = { ok: !!res.ok, checkedAt: Date.now() };
  } catch (_) {
    tableState = { ok: false, checkedAt: Date.now() };
  }
  return tableState.ok;
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function localList() {
  const db = dbm.load();
  if (!Array.isArray(db[LOCAL_COLLECTION])) db[LOCAL_COLLECTION] = [];
  while (db[LOCAL_COLLECTION].length > LOCAL_CAP) db[LOCAL_COLLECTION].pop();
  return db[LOCAL_COLLECTION];
}

function iso(v) { return v ? new Date(v).toISOString() : null; }
function ms(v) { const t = v ? new Date(v).getTime() : 0; return Number.isFinite(t) ? t : 0; }

function sanitizeContent(content) {
  return secrets.redactText(String(content === null || content === undefined ? '' : content))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTENT);
}

function normalizeKind(kind) {
  const k = String(kind || '').toLowerCase().trim();
  return KINDS.has(k) ? k : 'fact';
}

function normalizeImportance(v, kind) {
  const n = Number(v);
  const base = Number.isFinite(n) ? n : 0.5;
  const kindBias = kind === 'correction' ? 0.1 : kind === 'preference' ? 0.05 : 0;
  return Math.max(0, Math.min(1, Math.round((base + kindBias) * 1000) / 1000));
}

/** Public shape (never leaks anything internal; `embedding` is never returned). */
function publicMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    content: row.content,
    source: row.source || 'chat',
    kind: row.kind || 'fact',
    importance: Number(row.importance) || 0,
    dedupeKey: row.dedupe_key || row.dedupeKey || null,
    metadata: row.metadata || {},
    createdAt: row.created_at || row.createdAt || null,
    lastAccessed: row.last_accessed || row.lastAccessed || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    expiresAt: row.expires_at || row.expiresAt || null
  };
}

/* ─────────────────────────── BM25 (memory flavour) ─────────────────────────── */
/** Pure BM25 ranking over [{ id, content }]. Same parameters as brain.js (k1 1.5, b 0.75). */
function bm25Rank(query, docs) {
  const qTokens = tokenize(query);
  const list = Array.isArray(docs) ? docs : [];
  if (!qTokens.length || !list.length) return new Map();
  const docTokens = list.map((d) => tokenize(d.content || ''));
  const df = {};
  for (const toks of docTokens) for (const t of new Set(toks)) df[t] = (df[t] || 0) + 1;
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, list.length);
  const k1 = 1.5, b = 0.75;
  const out = new Map();
  for (let i = 0; i < list.length; i++) {
    const toks = docTokens[i];
    if (!toks.length) continue;
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const q of qTokens) {
      const hit = tf[q] ? q : Object.keys(tf).find((t) => t.startsWith(q) || q.startsWith(t));
      if (!hit) continue;
      const idf = Math.log(1 + (list.length - (df[hit] || 0) + 0.5) / ((df[hit] || 0) + 0.5));
      const raw = idf * (tf[hit] * (k1 + 1)) / (tf[hit] + k1 * (1 - b + b * (toks.length / avgLen)));
      score += tf[q] ? raw : raw * 0.6;   // partial-word match counts less, like the brain
    }
    if (score > 0) out.set(list[i].id, Math.round(score * 100) / 100);
  }
  return out;
}

/** Normalised 0..1 blend of lexical + semantic evidence. Pure (unit-tested). */
function blendScore(bm25Norm, cosine, weights = BLEND_WEIGHTS) {
  const lex = Math.max(0, Math.min(1, Number(bm25Norm) || 0));
  const sem = Math.max(0, Math.min(1, Number(cosine) || 0));
  return Math.round((weights.lexical * lex + weights.semantic * sem) * 1000) / 1000;
}

/* ─────────────────────────── writes ─────────────────────────── */
/**
 * Insert or update one memory. Always embeds at the table dimension.
 * @returns {Promise<object|null>} the public memory record (null when nothing was written)
 */
async function upsertMemory({ id, content, source = 'chat', kind = 'fact', importance, metadata, dedupeKey, expiresAt, embedding } = {}) {
  const text = sanitizeContent(content);
  if (!text) return null;
  const k = normalizeKind(kind);
  const vec = isVector(embedding) ? embedding : await getEmbedding(text, { dim: embedDim() });
  if (!isVector(vec)) return null;
  const nowIso = new Date().toISOString();
  const record = {
    id: id || uid('mem'),
    content: text,
    embedding: vec,
    source: String(source || 'chat').slice(0, 40),
    kind: k,
    importance: normalizeImportance(importance, k),
    dedupe_key: dedupeKey ? String(dedupeKey).slice(0, 200) : null,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    created_at: nowIso,
    updated_at: nowIso,
    last_accessed: nowIso,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null
  };

  if (await tableAvailable()) {
    const { url, key } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/${TABLE}?on_conflict=id`, {
        method: 'POST',
        headers: { ...headers(key), Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([record])
      });
      if (res.ok) {
        const rows = await res.json().catch(() => null);
        return publicMemory(Array.isArray(rows) && rows[0] ? rows[0] : record);
      }
    } catch (_) { /* fall through to the local copy — memory must never break a turn */ }
  }
  const list = localList();
  const idx = list.findIndex((m) => m && m.id === record.id);
  const existing = idx >= 0 ? list[idx] : null;
  const local = { ...record, created_at: existing ? existing.created_at : record.created_at, embedding: vec };
  if (idx >= 0) list[idx] = local; else list.unshift(local);
  try { await dbm.saveNow(); } catch (_) {}
  return publicMemory(local);
}

/**
 * Fetch candidate rows + their semantic scores.
 *  • Supabase: the match_aria_memories() RPC runs ONLY when we hold a real query vector —
 *    calling it with a null/short vector would either error or return noise. Without a live
 *    embedding backend this degrades to lexical-only over the most recent rows (honest).
 *  • Local: both sides use the same fallback hash vectors offline, so the cosine half stays
 *    meaningful with no keys and no Ollama.
 */
async function candidates(queryVector, { limit = 24, threshold = 0.05, query = '' } = {}) {
  const semantic = new Map();
  const rows = new Map();
  if (await tableAvailable()) {
    const { url, key } = supa();
    const want = Math.max(limit, DEFAULT_LIMIT * CANDIDATE_FACTOR);
    try {
      if (isVector(queryVector)) {
        const rpc = await fetchImpl(`${url}/rest/v1/rpc/match_aria_memories`, {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({ query_embedding: queryVector, match_threshold: threshold, match_count: want })
        });
        if (rpc.ok) {
          const hits = await rpc.json().catch(() => []);
          for (const h of Array.isArray(hits) ? hits : []) {
            semantic.set(h.id, Number(h.similarity) || 0);
            rows.set(h.id, h);
          }
        }
      }
      /* A second, cheap fetch gives the lexical half real text to score (semantic unknown → 0). */
      const recent = await fetchImpl(`${url}/rest/v1/${TABLE}?select=id,content,source,kind,importance,created_at,last_accessed,expires_at&order=created_at.desc&limit=${Math.max(want, 50)}`, { headers: headers(key) });
      if (recent.ok) {
        const list = await recent.json().catch(() => []);
        for (const r of Array.isArray(list) ? list : []) if (!rows.has(r.id)) rows.set(r.id, r);
      }
    } catch (_) { /* fall back to the local copy below */ }
  }
  if (!rows.size) {
    const localVec = isVector(queryVector) ? queryVector : fallbackVector(query, embedDim());
    for (const m of localList()) {
      const active = !m.expires_at || ms(m.expires_at) > Date.now();
      if (!active) continue;
      rows.set(m.id, m);
      if (isVector(m.embedding)) semantic.set(m.id, cosineSimilarity(localVec, m.embedding));
    }
  }
  return { rows, semantic };
}

/**
 * Hybrid retrieval: embed the query, pull candidates, blend BM25 with cosine similarity,
 * bump last_accessed for everything returned.
 * @returns {Promise<Array<object>>} ranked memories (public shape + `bm25`/`semantic`/`blended`)
 */
async function searchMemories(query, limit = DEFAULT_LIMIT) {
  const q = String(query || '').trim();
  const n = Math.max(1, Math.min(50, Number(limit) || DEFAULT_LIMIT));
  if (!q) return [];
  const queryVector = await getEmbedding(q, { dim: embedDim(), fallback: false });
  const { rows, semantic } = await candidates(queryVector, { limit: n * CANDIDATE_FACTOR, query: q });
  const list = [...rows.values()].map(publicMemory).filter((m) => m && m.content);
  if (!list.length) return [];
  const now = Date.now();
  const active = list.filter((m) => !m.expiresAt || ms(m.expiresAt) > now);
  const lexical = bm25Rank(q, active.map((m) => ({ id: m.id, content: m.content })));
  const maxLex = Math.max(0, ...[...lexical.values()]);
  const scored = active.map((m) => {
    const bm25 = lexical.get(m.id) || 0;
    const sem = semantic.get(m.id) || 0;
    return {
      ...m,
      bm25,
      semantic: Math.round(Math.max(0, sem) * 1000) / 1000,
      blended: blendScore(maxLex ? bm25 / maxLex : 0, sem),
      /* A memory that is important by score gets a small, honest tie-break nudge. */
      rank: blendScore(maxLex ? bm25 / maxLex : 0, sem) + (Number(m.importance) || 0) * 0.05
    };
  });
  const out = scored
    .sort((a, b) => b.rank - a.rank || b.blended - a.blended)
    .slice(0, n)
    .map(({ rank, ...rest }) => rest);
  if (out.length) touchMemories(out.map((m) => m.id)).catch(() => {});
  return out;
}

/** Bump last_accessed for the memories that were used. Forgiving: never throws. */
async function touchMemories(ids) {
  const clean = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 50);
  if (!clean.length) return { touched: 0 };
  const nowIso = new Date().toISOString();
  if (await tableAvailable()) {
    const { url, key } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/rpc/touch_aria_memories`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ memory_ids: clean })
      });
      if (res.ok) { await res.json().catch(() => null); return { touched: clean.length }; }
    } catch (_) { /* fall back to the local copy */ }
  }
  let touched = 0;
  for (const m of localList()) if (m && clean.includes(m.id)) { m.last_accessed = nowIso; touched++; }
  if (touched) { try { await dbm.saveNow(); } catch (_) {} }
  return { touched };
}

/**
 * The prompt block injected BEFORE the director/assistant reasons.
 * @returns {Promise<{ memories: Array, text: string, backend: string }>}
 */
async function retrieveForPrompt(message, { limit = DEFAULT_LIMIT } = {}) {
  let memories = [];
  try { memories = await searchMemories(message, limit); } catch (_) { memories = []; }
  return {
    memories,
    text: formatMemoriesForPrompt(memories),
    backend: (await tableAvailable()) ? 'supabase' : 'local'
  };
}

/** Pure: render memories as a prompt block (empty string when there is nothing to say). */
function formatMemoriesForPrompt(memories) {
  const list = Array.isArray(memories) ? memories.filter((m) => m && m.content) : [];
  if (!list.length) return '';
  const lines = list.map((m) => {
    const kind = m.kind && m.kind !== 'fact' ? `${m.kind}: ` : '';
    return `- ${kind}${String(m.content).replace(/\s+/g, ' ').slice(0, 400)}`;
  });
  return `MEMORY (durable facts and preferences about your owner, retrieved by relevance — trust these over your assumptions, do not contradict them, and never invent more):\n${lines.join('\n')}`;
}

/* ─────────────────────────── management (UI / "forget that") ─────────────────────────── */
async function listMemories({ limit = 50, offset = 0 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  if (await tableAvailable()) {
    const { url, key } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/${TABLE}?select=id,content,source,kind,importance,dedupe_key,metadata,created_at,last_accessed,updated_at,expires_at&order=created_at.desc&limit=${n}&offset=${off}`, { headers: headers(key) });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        return (Array.isArray(rows) ? rows : []).map(publicMemory);
      }
    } catch (_) { /* fall through */ }
  }
  return localList().slice(off, off + n).map(publicMemory);
}

async function getMemory(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  if (await tableAvailable()) {
    const { url, key: sk } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/${TABLE}?select=id,content,source,kind,importance,dedupe_key,metadata,created_at,last_accessed,updated_at,expires_at&id=eq.${encodeURIComponent(key)}&limit=1`, { headers: headers(sk) });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        if (Array.isArray(rows) && rows[0]) return publicMemory(rows[0]);
      }
    } catch (_) { /* fall through */ }
  }
  const found = localList().find((m) => m && m.id === key);
  return found ? publicMemory(found) : null;
}

/**
 * Edit a memory. Changing `content` re-embeds it (dimension-safe); metadata/kind/importance
 * updates are cheap. `dedupeKey` collisions are resolved by writing null (never break an edit).
 */
async function updateMemory(id, patch = {}) {
  const key = String(id || '').trim();
  if (!key) return null;
  const current = await getMemory(key);
  if (!current) return null;
  const next = {
    content: patch.content !== undefined ? sanitizeContent(patch.content) : current.content,
    kind: patch.kind !== undefined ? normalizeKind(patch.kind) : current.kind,
    importance: patch.importance !== undefined ? normalizeImportance(patch.importance, patch.kind !== undefined ? normalizeKind(patch.kind) : current.kind) : current.importance,
    source: patch.source !== undefined ? String(patch.source).slice(0, 40) : current.source,
    metadata: patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : current.metadata,
    expiresAt: patch.expiresAt !== undefined ? (patch.expiresAt ? new Date(patch.expiresAt).toISOString() : null) : current.expiresAt
  };
  if (!next.content) return null;
  const contentChanged = next.content !== current.content;
  const vec = contentChanged ? await getEmbedding(next.content, { dim: embedDim() }) : null;
  const row = {
    content: next.content,
    kind: next.kind,
    importance: next.importance,
    source: next.source,
    metadata: next.metadata,
    expires_at: next.expiresAt,
    updated_at: new Date().toISOString(),
    ...(isVector(vec) ? { embedding: vec } : {})
  };
  if (await tableAvailable()) {
    const { url, key: sk } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: { ...headers(sk), Prefer: 'return=representation' },
        body: JSON.stringify(row)
      });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        return publicMemory(Array.isArray(rows) && rows[0] ? rows[0] : { ...current, ...row });
      }
    } catch (_) { /* fall through */ }
  }
  const list = localList();
  const idx = list.findIndex((m) => m && m.id === key);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...row, id: key, dedupe_key: list[idx].dedupe_key };
  try { await dbm.saveNow(); } catch (_) {}
  return publicMemory(list[idx]);
}

async function removeMemory(id) {
  const key = String(id || '').trim();
  if (!key) return { deleted: false };
  if (await tableAvailable()) {
    const { url, key: sk } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { ...headers(sk), Prefer: 'return=representation' }
      });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        if (Array.isArray(rows) && rows.length) return { deleted: true, id: key };
      }
    } catch (_) { /* fall through */ }
  }
  const list = localList();
  const before = list.length;
  const kept = list.filter((m) => !(m && m.id === key));
  if (kept.length !== before) {
    dbm.load()[LOCAL_COLLECTION] = kept;
    try { await dbm.saveNow(); } catch (_) {}
    return { deleted: true, id: key };
  }
  return { deleted: false, id: key };
}

/** Forget several memories at once (used by "forget that about X"). */
async function removeMany(ids) {
  const list = (Array.isArray(ids) ? ids : []).slice(0, 100);
  let deleted = 0;
  for (const id of list) {
    const r = await removeMemory(id).catch(() => ({ deleted: false }));
    if (r.deleted) deleted++;
  }
  return { deleted, asked: list.length };
}

/** Delete every memory (Settings → clear). */
async function forgetAll() {
  const all = await listMemories({ limit: 200 });
  const ids = all.map((m) => m.id);
  const res = await removeMany(ids);
  return res;
}

/**
 * Prune memories whose `expires_at` has passed. Nothing is deleted early: rows without an
 * expiry are kept forever. (Phase 3 extends this with the staleness/low-importance policy.)
 * @returns {Promise<{expired: number}>}
 */
async function expireStale(now = Date.now()) {
  let expired = 0;
  if (await tableAvailable()) {
    const { url, key } = supa();
    try {
      const res = await fetchImpl(`${url}/rest/v1/${TABLE}?expires_at=not.is.null&expires_at=lt.${new Date(now).toISOString()}`, {
        method: 'DELETE',
        headers: { ...headers(key), Prefer: 'return=representation' }
      });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        expired += Array.isArray(rows) ? rows.length : 0;
      }
    } catch (_) { /* fall through to the local copy */ }
  }
  const list = localList();
  const kept = list.filter((m) => !(m && m.expires_at && ms(m.expires_at) <= now));
  if (kept.length !== list.length) {
    dbm.load()[LOCAL_COLLECTION] = kept;
    expired += list.length - kept.length;
    try { await dbm.saveNow(); } catch (_) {}
  }
  return { expired };
}

async function stats() {
  const remote = await tableAvailable();
  const rows = remote ? (await listMemories({ limit: 200 })) : localList().map(publicMemory);
  const now = Date.now();
  return {
    backend: remote ? 'supabase' : 'local',
    table: TABLE,
    dim: embedDim(),
    count: rows.length,
    active: rows.filter((m) => !m.expiresAt || ms(m.expiresAt) > now).length,
    expired: rows.filter((m) => m.expiresAt && ms(m.expiresAt) <= now).length,
    kinds: rows.reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc; }, {}),
    newest: rows[0] ? rows[0].createdAt : null
  };
}

function _reset() {
  tableState = { ok: null, checkedAt: 0 };
  const db = dbm.load();
  db[LOCAL_COLLECTION] = [];
  fetchImpl = (...a) => fetch(...a);
}

module.exports = {
  TABLE, LOCAL_COLLECTION, KINDS, BLEND_WEIGHTS, DEFAULT_LIMIT,
  tableAvailable, upsertMemory, searchMemories, touchMemories, retrieveForPrompt, formatMemoriesForPrompt,
  listMemories, getMemory, updateMemory, removeMemory, removeMany, forgetAll, expireStale, stats,
  bm25Rank, blendScore, publicMemory, sanitizeContent, embedDim,
  _reset, _setFetch, fallbackVector
};
