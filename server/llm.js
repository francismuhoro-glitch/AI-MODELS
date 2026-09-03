'use strict';
/* LLM adapter — three providers, tried in order, all optional:
     1. openai  — any OpenAI-compatible cloud endpoint (settings.llm.openai.apiKey or the
                  OPENAI_API_KEY env var). OFF unless a key exists; the key is never logged
                  and never leaves this module.
     2. ollama  — local, private, free (settings.llm.ollamaUrl).
     3. offline — no model at all: llmChat() answers { text: null } and assistant.js falls
                  back to its built-in heuristic engine, so ARIA keeps working.

   provider 'auto' (default) = cloud if configured → local Ollama → offline.

   TOOL CALLING: llmChat(system, user, history, tools) — when `tools` is passed, the system
   prompt is extended with an instruction to answer with ONLY a compact JSON object
   {"tool":"<name>","args":{…}} whenever the user asks for an action. assistant.js parses
   that (parseToolCall) and executes it for real, so the model can ACT instead of only chat. */
const cfgm = require('./config');

let ollamaState = { ok: null, checkedAt: 0, models: [] };

/* Reachability of the local Ollama daemon, cached for a minute (it is polled on every turn). */
async function checkOllama() {
  if (Date.now() - ollamaState.checkedAt < 60_000) return ollamaState.ok;
  const cfg = cfgm.load();
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${cfg.llm.ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: ctl.signal });
    const json = await res.json();
    clearTimeout(t);
    ollamaState = { ok: res.ok, checkedAt: Date.now(), models: (json.models || []).map(m => m.name) };
  } catch (_) { ollamaState = { ok: false, checkedAt: Date.now(), models: [] }; }
  return ollamaState.ok;
}

/* ---------- OpenAI-compatible provider ---------- */
/* The key comes from settings OR the environment. It is used in one Authorization header and
   never returned by llmStatus(), never written to the DB and never logged. */
function openaiConfig(cfg) {
  const c = cfg || cfgm.load();
  const o = (c.llm && c.llm.openai) || {};
  return {
    apiKey: String(o.apiKey || process.env.OPENAI_API_KEY || '').trim(),
    baseUrl: String(o.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: String(o.model || 'gpt-4o-mini')
  };
}

function openaiConfigured(cfg) { return !!openaiConfig(cfg).apiKey; }

/**
 * Which providers should be tried, in order? Pure function of (config, availability) so it
 * can be unit-tested without any network: no key + no Ollama → [] → the caller stays offline.
 */
function resolveProviders(cfg, avail = {}) {
  const c = cfg || cfgm.load();
  const provider = (c.llm && c.llm.provider) || 'auto';
  const key = openaiConfig(c).apiKey;
  if (provider === 'offline') return [];
  if (provider === 'openai') return key ? ['openai'] : [];
  if (provider === 'ollama') return ['ollama'];
  const plan = [];
  if (key && avail.openai !== false) plan.push('openai');          // cloud first: smartest, and it can tool-call
  if (avail.ollama) plan.push('ollama');
  return plan;
}

/* Async wrapper — only probes Ollama when the provider setting can actually use it. */
async function planProviders(cfg) {
  const c = cfg || cfgm.load();
  const provider = (c.llm && c.llm.provider) || 'auto';
  const avail = { openai: true, ollama: false };
  if (provider === 'ollama') avail.ollama = true;
  else if (provider === 'auto') avail.ollama = !!(await checkOllama());
  return resolveProviders(c, avail);
}

/* ---------- Tool-calling prompt ---------- */
function toolPrompt(tools) {
  const list = (Array.isArray(tools) ? tools : []).map(t => {
    const args = Object.entries(t.args || {})
      .map(([k, v]) => `${k}${v && v.optional ? '?' : ''}: ${v && v.type ? v.type : 'string'}`)
      .join(', ');
    return `- ${t.name}(${args}) — ${t.description || ''}`;
  }).join('\n');
  return `\n\nTOOLS — you can ACT, not only chat.
When the user asks you to do something (create/move/cancel an event, add or complete a task,
look something up in their calendar, their second brain or the live web, or plan their day),
reply with ONLY a compact JSON object — no prose, no markdown fences, no commentary:
{"tool":"<tool_name>","args":{<arguments>}}
Available tools:
${list}
Rules:
- Dates/times MUST be ISO-8601 with an explicit offset, e.g. 2026-09-04T14:00:00+03:00.
- Use CURRENT TIME and the CONTEXT above to resolve "tomorrow", "at 2pm", "on Friday".
- Never invent a result and never claim you did something without emitting a tool call.
- If the user is only making conversation or asking a general question, answer in plain text
  (no JSON) as usual.`;
}

function buildMessages(system, user, history) {
  /* Multi-turn conversation memory: the caller passes prior turns ({role, content}) so the
     model can resolve follow-ups like "what about tomorrow?". */
  const messages = [{ role: 'system', content: String(system || '') }];
  for (const h of (Array.isArray(history) ? history : []).slice(-10)) {
    if (h && h.content) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) });
  }
  messages.push({ role: 'user', content: String(user || '') });
  return messages;
}

/* ---------- Provider calls ---------- */
async function chatOllama(cfg, messages) {
  const want = cfg.llm.model && ollamaState.models.some(m => m.startsWith(cfg.llm.model))
    ? cfg.llm.model
    : (ollamaState.models[0] || cfg.llm.model);
  const res = await fetch(`${cfg.llm.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: want, stream: false, messages }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const json = await res.json();
  const text = (json.message && json.message.content) || null;
  if (!text) throw new Error('ollama empty reply');
  return { text, engine: `ollama:${want}` };
}

async function chatOpenAI(cfg, messages) {
  const o = openaiConfig(cfg);
  if (!o.apiKey) throw new Error('openai: no api key configured');
  const res = await fetch(`${o.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
    body: JSON.stringify({ model: o.model, stream: false, temperature: 0.4, messages }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) {
    /* Read the body for a useful message but never echo the request headers (they carry the key). */
    const detail = await res.text().catch(() => '');
    throw new Error(`openai ${res.status} ${String(detail).slice(0, 160)}`);
  }
  const json = await res.json();
  const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || null;
  if (!text) throw new Error('openai empty reply');
  return { text, engine: `openai:${o.model}` };
}

/**
 * Chat with the best available provider.
 * @param {string} system   system prompt
 * @param {string} user     the user turn (context is usually baked into it)
 * @param {Array}  history  prior {role, content} turns (multi-turn memory)
 * @param {Array}  tools    optional tool definitions → the model may answer with a JSON tool call
 * @returns {Promise<{text: string|null, engine: string, error?: string}>}
 *          text === null means "no model answered" → the caller must use its offline engine.
 */
async function llmChat(system, user, history, tools) {
  const cfg = cfgm.load();
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const sys = hasTools ? String(system || '') + toolPrompt(tools) : String(system || '');
  const messages = buildMessages(sys, user, history);

  let plan = [];
  try { plan = await planProviders(cfg); } catch (_) { plan = []; }
  let lastError = null;
  for (const provider of plan) {
    try {
      const out = provider === 'openai' ? await chatOpenAI(cfg, messages) : await chatOllama(cfg, messages);
      if (out && out.text) return { ...out, tools: hasTools };
    } catch (e) { lastError = (e && e.message) || 'llm error'; /* fall through to the next provider */ }
  }
  return { text: null, engine: 'offline', ...(lastError ? { error: lastError } : {}), tools: hasTools };
}

function llmStatus() {
  const cfg = cfgm.load();
  const o = openaiConfig(cfg);
  const provider = cfg.llm.provider;
  const activeEngine = provider === 'offline' ? 'offline'
    : (provider === 'openai' || (provider === 'auto' && o.apiKey)) ? 'openai'
      : (provider === 'ollama' || (provider === 'auto' && ollamaState.ok)) ? 'ollama' : 'offline';
  return {
    provider,
    ollamaUrl: cfg.llm.ollamaUrl,
    model: cfg.llm.model,
    recommendedModel: cfg.llm.recommendedModel || 'qwen2.5:7b',
    ollamaReachable: ollamaState.ok,
    models: ollamaState.models,
    /* The cloud provider is reported as configured/not — the key itself never leaves llm.js. */
    openai: { configured: !!o.apiKey, baseUrl: o.baseUrl, model: o.model },
    openaiConfigured: !!o.apiKey,
    tools: true,
    activeEngine
  };
}

/* Test helper — forget cached reachability so the next call re-probes. */
function _reset() { ollamaState = { ok: null, checkedAt: 0, models: [] }; }

module.exports = {
  llmChat, llmStatus, checkOllama, toolPrompt, buildMessages,
  resolveProviders, planProviders, openaiConfig, openaiConfigured, _reset
};
