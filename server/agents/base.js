'use strict';
/* Agency Swarm — shared agent primitives.
   ZERO dependencies: every agent is a plain class with an async run(ctx) that returns a
   trace step. Agents never talk to each other directly — they read and write the shared
   mission context (ctx.shared), which is what makes sequential AND parallel waves safe. */

const { llmChat } = require('../llm');
const { snippet } = require('../util');

/* ---------- text helpers shared by the whole swarm ---------- */

const MONEY_RE = /\b(?:kes|ksh|usd|eur|gbp|\$|€|£)\s?\d[\d,]*(?:\.\d{1,2})?\b|\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b/gi;
const MONEY_WORDS = ['invoice', 'payment', 'mpesa', 'quote', 'quotation', 'pricing', 'budget', 'deposit', 'refund', 'receipt', 'purchase order', 'lpo', 'paid', 'balance', 'revenue', 'cost'];

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function money(text) {
  const found = String(text || '').match(MONEY_RE) || [];
  return [...new Set(found.map(s => s.trim()))].slice(0, 4);
}

function isFinancial(text) {
  const t = String(text || '').toLowerCase();
  return MONEY_WORDS.some(w => t.includes(w)) || MONEY_RE.test(t);
}

function bullets(list, empty = '_Nothing found._') {
  const items = (list || []).filter(Boolean);
  return items.length ? items.map(l => `- ${l}`).join('\n') : empty;
}

function urlsIn(text) {
  const found = String(text || '').match(/https?:\/\/[^\s"'<>\])]+/gi) || [];
  return [...new Set(found.map(u => u.replace(/[.,;!?]+$/, '')))];
}

/* Split a multi-step instruction into ordered sub-tasks.
   "Scan the supplier notes and draft an executive briefing, then list next actions"
     → ["Scan the supplier notes", "draft an executive briefing", "list next actions"] */
const ACTION_VERB = '(?:draft|write|compose|send|reply|create|prepare|produce|build|plan|summari[sz]e|analy[sz]e|review|scan|research|investigate|find|look\\s?up|gather|list|report|check|propose|email|update|outline)';
const SPLIT_RE = new RegExp(
  `\\s*(?:[;\\n]|,?\\s+then\\s+|\\s+and\\s+then\\s+|\\s+after\\s+that\\s+|\\s+&&\\s+|,?\\s+and\\s+(?=${ACTION_VERB}\\b)|,\\s+(?=${ACTION_VERB}\\b))\\s*`,
  'i'
);

function splitSubtasks(task) {
  const raw = String(task || '').trim();
  if (!raw) return [];
  const numbered = raw.split(/\s*(?:\d+[.)]\s+|\n\s*[-*]\s+)/).map(s => s.trim()).filter(Boolean);
  const base = numbered.length > 1 ? numbered : [raw];
  const parts = [];
  for (const chunk of base) {
    chunk
      .split(SPLIT_RE)
      .map(s => s.trim().replace(/^(?:and|also|please)\s+/i, '').replace(/[.\s]+$/, ''))
      .filter(s => s.length > 2)
      .forEach(s => parts.push(s));
  }
  const seen = new Set();
  return parts.filter(p => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
}

/* Ask the local LLM, but never depend on it: `fallback` always produces a real answer. */
async function think(system, user, fallback) {
  try {
    const { text, engine } = await llmChat(system, user);
    if (text && String(text).trim()) return { text: String(text).trim(), engine: engine || 'llm' };
  } catch (_) { /* offline is a normal state, not an error */ }
  return { text: String(fallback || '').trim(), engine: 'offline-engine' };
}

/* ---------- the agent base class ---------- */

class Agent {
  constructor({ id, name, emoji, role, description, skills = [] }) {
    this.id = id;
    this.name = name;
    this.emoji = emoji || '🤖';
    this.role = role || '';
    this.description = description || '';
    this.skills = skills;
  }

  /* Public, serialisable identity — used by GET /api/agency/agents and the frontend roster. */
  card() {
    return { id: this.id, name: this.name, emoji: this.emoji, role: this.role, description: this.description, skills: this.skills };
  }

  /* Does this agent add value to this mission? Directors use it for auto-delegation. */
  relevance() { return 0; }

  /* Every agent answers with the SAME step shape so the trace is uniform. */
  step(action, result, meta) {
    return {
      agent: this.name,
      agentId: this.id,
      emoji: this.emoji,
      role: this.role,
      action: String(action || 'work'),
      result: String(result == null ? '' : result),
      ok: true,
      ...(meta ? { meta } : {})
    };
  }

  failStep(action, error) {
    return {
      agent: this.name, agentId: this.id, emoji: this.emoji, role: this.role,
      action: String(action || 'work'),
      result: `⚠️ ${this.name} could not finish: ${(error && error.message) || error || 'unknown error'}`,
      ok: false
    };
  }

  // eslint-disable-next-line no-unused-vars
  async run(ctx) { throw new Error(`${this.id} has no run()`); }
}

module.exports = { Agent, think, money, isFinancial, bullets, urlsIn, splitSubtasks, snippet, PRIORITY_RANK };
