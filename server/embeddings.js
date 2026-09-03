'use strict';
/* EMBEDDINGS — the semantic half of ARIA's memory.
   getEmbedding() asks the local Ollama daemon for a vector; when no daemon is reachable it
   degrades to a deterministic TF-IDF-style hashing vector (fallbackVector) so cosine
   similarity still means something offline, or returns null when the caller asked for a
   "real embedding only" (brain.js uses that to stay 100% lexical without Ollama).
   Nothing here ever throws: a missing model, a timeout or a read-only fs all degrade quietly. */
const cfgm = require('./config');

/* Reachability of the embedding backend, cached — brain.js asks on every search. */
let backend = { live: null, checkedAt: 0 };

async function embeddingBackendLive() {
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

/* Deterministic fast TF-IDF style vector for fallback */
function fallbackVector(text, dim = 64) {
  const vec = new Array(dim).fill(0);
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return vec;
  for (const w of words) {
    let hash = 0;
    for (let i = 0; i < w.length; i++) hash = (hash * 31 + w.charCodeAt(i)) & 0xffffffff;
    const idx = Math.abs(hash) % dim;
    vec[idx] += 1;
  }
  let sumSq = vec.reduce((s, v) => s + v * v, 0);
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map(v => v / norm);
}

function isVector(v) { return Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'number' && Number.isFinite(n)); }

/* Which model can actually produce embeddings here? Tried in order, failures remembered so a
   missing model costs one request per process instead of one per note. */
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

/**
 * Embed a string.
 * @param {string} text
 * @param {object} opts  { fallback: true } → return fallbackVector() when Ollama is unreachable
 *                       { force: true }    → skip the reachability probe and try anyway
 * @returns {Promise<number[]|null>}
 */
async function getEmbedding(text, opts = {}) {
  const allowFallback = opts.fallback !== false;
  const body = String(text || '').slice(0, 1500);
  if (!body.trim()) return allowFallback ? fallbackVector(body) : null;
  if (!opts.force && !(await embeddingBackendLive())) return allowFallback ? fallbackVector(body) : null;
  const cfg = cfgm.load();
  const host = String((cfg.llm && cfg.llm.ollamaUrl) || (cfg.ollama && cfg.ollama.host) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const candidates = embedModel ? [embedModel] : embedModelCandidates(cfg);
  for (const model of candidates) {
    if (badModels.has(model)) continue;
    try {
      const res = await fetch(`${host}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: body }),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = await res.json();
        if (isVector(data.embedding)) { embedModel = model; return data.embedding; }
      }
      badModels.add(model);
    } catch (_) { badModels.add(model); }
  }
  /* A reachable daemon without an embedding model is the common case — degrade quietly. */
  return allowFallback ? fallbackVector(body) : null;
}

function _reset() { backend = { live: null, checkedAt: 0 }; embedModel = null; badModels.clear(); }

module.exports = { getEmbedding, cosineSimilarity, fallbackVector, embeddingBackendLive, isVector, _reset };
