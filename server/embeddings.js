'use strict';
/* EMBEDDINGS — the semantic half of ARIA's memory.
   Provider chain (first one that works wins):
     1. cloud   — any OpenAI-compatible /embeddings endpoint. ONLY tried when a key exists
                  (settings.llm.openai.apiKey or OPENAI_API_KEY). Off by default.
     2. ollama  — the local daemon (settings.llm.ollamaUrl). Private and free.
     3. lexical — a deterministic hashing vector (fallbackVector), so similarity search still
                  means something with no model, no keys and no network.
   Dimension consistency: whatever the backend returns is fitted to the requested dimension
   (`fitDimension`). server/memory.js asks for the dimension of the aria_memory table
   (settings.llm.embedDim, default 768) so a row can never be written with a vector the
   pgvector column would reject. The second brain passes no dimension and keeps the
   provider's native size, exactly as before.
   Nothing here ever throws: a missing model, a bad key, a timeout or a read-only fs all
   degrade quietly to the next provider. */
const cfgm = require('./config');

const DEFAULT_DIM = 768;
const DIM_MIN = 64;
const DIM_MAX = 3072;

/* Cloud failures cool down so a wrong key does not slow down every single chat turn. */
const CLOUD_COOLDOWN_MS = 120_000;
let cloudDownUntil = 0;

/* Reachability of the (local) embedding backend, cached — brain.js asks on every search. */
let backend = { live: null, checkedAt: 0 };

/* Injectable transport — tests swap this to verify the chain with zero network. */
let fetchImpl = (...args) => fetch(...args);
function _setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

/** The dimension every vector must have: settings.llm.embedDim (env ARIA_EMBED_DIM wins). */
function embedDim() {
  let configured = null;
  try { configured = (cfgm.load().llm || {}).embedDim; } catch (_) { configured = null; }
  const raw = process.env.ARIA_EMBED_DIM || configured;
  const n = Number(raw);
  return Number.isFinite(n) && n >= DIM_MIN && n <= DIM_MAX ? Math.round(n) : DEFAULT_DIM;
}

/* ---------- cloud (OpenAI-compatible) ---------- */
function cloudConfig() {
  let o = {};
  try { o = (cfgm.load().llm || {}).openai || {}; } catch (_) { o = {}; }
  const apiKey = String(o.apiKey || process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(o.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(o.embedModel || process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small');
  return { apiKey, baseUrl, model };
}
const cloudConfigured = () => !!cloudConfig().apiKey;

/* Only OpenAI's text-embedding-3-* family understands the `dimensions` parameter. Other
   OpenAI-compatible servers 400 on it, so we only send it for those models. */
const supportsDimensionsParam = (model) => /text-embedding-3/i.test(String(model || ''));

/** Ollama (or any local daemon) reachable right now? Cloud keys short-circuit this. */
async function embeddingBackendLive() {
  if (cloudConfigured() && Date.now() > cloudDownUntil) return true;
  if (backend.live !== null && Date.now() - backend.checkedAt < 120_000) return backend.live;
  try {
    const { checkOllama } = require('./llm');
    backend = { live: !!(await checkOllama()), checkedAt: Date.now() };
  } catch (_) {
    backend = { live: false, checkedAt: Date.now() };
  }
  return backend.live;
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Deterministic fast TF-IDF style vector for the offline fallback. */
function fallbackVector(text, dim = 64) {
  const n = Number.isFinite(Number(dim)) && Number(dim) >= 8 ? Math.round(Number(dim)) : 64;
  const vec = new Array(n).fill(0);
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return vec;
  for (const w of words) {
    let hash = 0;
    for (let i = 0; i < w.length; i++) hash = (hash * 31 + w.charCodeAt(i)) & 0xffffffff;
    const idx = Math.abs(hash) % n;
    vec[idx] += 1;
  }
  const sumSq = vec.reduce((s, v) => s + v * v, 0);
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map(v => v / norm);
}

function isVector(v) { return Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'number' && Number.isFinite(n)); }

function normalizeVec(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

/**
 * Make a vector exactly `dim` long, unit-normalised.
 *  • longer → truncate (this is exactly what OpenAI does for text-embedding-3 via `dimensions`
 *    — Matryoshka training makes the leading dims meaningful) and renormalise.
 *  • shorter → zero-pad and renormalise (keeps cosine geometry; a non-Matryoshka model loses a
 *    little fidelity, which is why we prefer matching models in the first place).
 * Returns null when the input is not a usable vector.
 */
function fitDimension(vec, dim) {
  const n = Number(dim);
  if (!isVector(vec) || !Number.isFinite(n) || n < 1) return null;
  const target = Math.round(n);
  let out;
  if (vec.length === target) out = vec.slice();
  else if (vec.length > target) out = vec.slice(0, target);
  else out = vec.concat(new Array(target - vec.length).fill(0));
  return normalizeVec(out);
}

/* ---------- Ollama candidate models (failures remembered per process) ---------- */
let embedModel = null;
const badModels = new Set();

function embedModelCandidates(cfg) {
  const list = [
    cfg.llm && cfg.llm.embedModel,
    cfg.ollama && cfg.ollama.model,
    cfg.llm && cfg.llm.model,
    'nomic-embed-text'
  ];
  return [...new Set(list.filter(Boolean).map(m => String(m)))];
}

/** Try the cloud provider. Returns a fitted vector or null (never throws). */
async function cloudEmbedding(body, dim) {
  const c = cloudConfig();
  if (!c.apiKey) return null;
  if (Date.now() < cloudDownUntil) return null;
  const payload = { model: c.model, input: body };
  if (supportsDimensionsParam(c.model) && dim) payload.dimensions = dim;
  try {
    const res = await fetchImpl(`${c.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) { cloudDownUntil = Date.now() + CLOUD_COOLDOWN_MS; return null; }
    const data = await res.json().catch(() => null);
    const raw = data && data.data && data.data[0] && data.data[0].embedding;
    const fitted = fitDimension(raw, dim || (isVector(raw) ? raw.length : 0));
    return fitted;
  } catch (_) {
    cloudDownUntil = Date.now() + CLOUD_COOLDOWN_MS;
    return null;
  }
}

/** Try the local Ollama daemon. Returns a fitted vector or null. */
async function ollamaEmbedding(body, dim) {
  const cfg = cfgm.load();
  const host = String((cfg.llm && cfg.llm.ollamaUrl) || (cfg.ollama && cfg.ollama.host) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const candidates = embedModel ? [embedModel] : embedModelCandidates(cfg);
  for (const model of candidates) {
    if (badModels.has(model)) continue;
    try {
      const res = await fetchImpl(`${host}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: body }),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = await res.json();
        if (isVector(data.embedding)) {
          embedModel = model;
          /* The table's dimension wins when one was requested (Ollama models vary: 384/768/1024). */
          return dim ? fitDimension(data.embedding, dim) : data.embedding;
        }
      }
      badModels.add(model);
    } catch (_) { badModels.add(model); }
  }
  return null;
}

/** What can actually embed right now — for /api/ai/status and the UI (never leaks the key). */
async function embeddingStatus() {
  const c = cloudConfig();
  const dim = embedDim();
  const cloudUp = !!c.apiKey && Date.now() > cloudDownUntil;
  let ollamaUp = false;
  try {
    const { checkOllama } = require('./llm');
    ollamaUp = !!(await checkOllama());
  } catch (_) { ollamaUp = false; }
  return {
    dim,
    cloudConfigured: !!c.apiKey,
    cloudModel: c.apiKey ? c.model : '',
    cloudCoolingDown: Date.now() < cloudDownUntil,
    ollamaReachable: ollamaUp,
    activeBackend: cloudUp ? 'cloud' : ollamaUp ? 'ollama' : 'lexical'
  };
}

/**
 * Embed a string.
 * @param {string} text
 * @param {object} opts  { fallback: true }  → return fallbackVector() when nothing is reachable
 *                       { force: true }     → skip the reachability probe and try anyway
 *                       { dim: 768 }        → fit the result to this dimension (memory table)
 * @returns {Promise<number[]|null>}
 */
async function getEmbedding(text, opts = {}) {
  const allowFallback = opts.fallback !== false;
  const dim = Number.isFinite(Number(opts.dim)) ? Math.round(Number(opts.dim)) : null;
  const body = String(text || '').slice(0, 2000);
  if (!body.trim()) return allowFallback ? fallbackVector(body, dim || 64) : null;

  if (!opts.force && !(await embeddingBackendLive())) {
    return allowFallback ? fallbackVector(body, dim || 64) : null;
  }

  /* 1. cloud (only when a key exists) */
  if (opts.cloud !== false) {
    const cloud = await cloudEmbedding(body, dim);
    if (cloud) return cloud;
  }
  /* 2. Ollama */
  if (opts.ollama !== false) {
    const local = await ollamaEmbedding(body, dim);
    if (local) return local;
  }
  /* 3. lexical */
  return allowFallback ? fallbackVector(body, dim || 64) : null;
}

function _reset() {
  backend = { live: null, checkedAt: 0 };
  embedModel = null;
  badModels.clear();
  cloudDownUntil = 0;
  fetchImpl = (...a) => fetch(...a);
}

module.exports = {
  getEmbedding, cosineSimilarity, fallbackVector, embeddingBackendLive, isVector, fitDimension,
  embedDim, cloudConfigured, cloudConfig, embeddingStatus, DEFAULT_DIM,
  _reset, _setFetch
};
