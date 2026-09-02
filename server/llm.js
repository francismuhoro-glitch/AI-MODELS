'use strict';
/* LLM adapter — primary: local Ollama (private, free). Fallback: built-in offline engine.
   provider 'auto' = try Ollama, fall back gracefully. */
const cfgm = require('./config');

let ollamaState = { ok: null, checkedAt: 0, models: [] };

async function checkOllama() {
  if (Date.now() - ollamaState.checkedAt < 60_000) return ollamaState.ok;
  const cfg = cfgm.load();
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${cfg.llm.ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: ctl.signal });
    const json = await res.json();
    ollamaState = { ok: res.ok, checkedAt: Date.now(), models: (json.models || []).map(m => m.name) };
  } catch (_) { ollamaState = { ok: false, checkedAt: Date.now(), models: [] }; }
  return ollamaState.ok;
}

async function llmChat(system, user, history) {
  const cfg = cfgm.load();
  const want = cfg.llm.provider === 'ollama' || (cfg.llm.provider === 'auto' && (await checkOllama()));
  if (!want) return { text: null, engine: 'offline' };
  try {
    const model = cfg.llm.model && ollamaState.models.some(m => m.startsWith(cfg.llm.model)) ? cfg.llm.model
      : (ollamaState.models[0] || cfg.llm.model);
    /* Multi-turn conversation memory: the caller passes prior turns ({role, content}) so
       the model can resolve follow-ups like "what about tomorrow?". */
    const messages = [{ role: 'system', content: system }];
    for (const h of (Array.isArray(history) ? history : []).slice(-10)) {
      if (h && h.content) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) });
    }
    messages.push({ role: 'user', content: user });
    const res = await fetch(`${cfg.llm.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages })
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const json = await res.json();
    return { text: json.message?.content || null, engine: `ollama:${model}` };
  } catch (e) {
    if (cfg.llm.provider === 'ollama') return { text: null, engine: 'offline', error: e.message };
    return { text: null, engine: 'offline' };
  }
}

function llmStatus() {
  const cfg = cfgm.load();
  return {
    provider: cfg.llm.provider, ollamaUrl: cfg.llm.ollamaUrl, model: cfg.llm.model,
    ollamaReachable: ollamaState.ok, models: ollamaState.models,
    activeEngine: (cfg.llm.provider === 'ollama' || (cfg.llm.provider === 'auto' && ollamaState.ok)) ? 'ollama' : 'offline'
  };
}

module.exports = { llmChat, llmStatus, checkOllama };
