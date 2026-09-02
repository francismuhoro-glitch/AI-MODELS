'use strict';
const cfgm = require('./config');

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

// Deterministic fast TF-IDF style vector for fallback
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

async function getEmbedding(text) {
  const cfg = cfgm.load();
  const host = (cfg.ollama && cfg.ollama.host) || 'http://127.0.0.1:11434';
  const model = (cfg.ollama && cfg.ollama.model) || 'llama3.1';
  try {
    const res = await fetch(`${host}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: String(text || '').slice(0, 1500) }),
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.embedding && Array.isArray(data.embedding)) return data.embedding;
    }
  } catch (_) {}
  return fallbackVector(text);
}

module.exports = { getEmbedding, cosineSimilarity };
