const websearch = require('../websearch');
'use strict';
/* ResearcherAgent — queries the second brain, crawls external URLs, gathers facts. */

const brain = require('../brain');
const dbm = require('../db');
const weblearn = require('../weblearn');
const { Agent, urlsIn, snippet } = require('./base');

const RESEARCH_HINTS = /\b(research|find|look ?up|investigate|gather|source|evidence|facts?|what do (?:we|i) know|background|context|notes?|supplier|competitor|market|read|crawl|scan)\b/i;

class ResearcherAgent extends Agent {
  constructor() {
    super({
      id: 'researcher',
      name: 'ResearcherAgent',
      emoji: '🔎',
      role: 'Research & retrieval',
      description: 'Queries the second brain, crawls external URLs and gathers the facts the rest of the swarm reasons over.',
      skills: ['second-brain search', 'web crawling', 'fact extraction']
    });
  }

  relevance(task) {
    let s = 0.35;                                   // research is almost always useful
    if (RESEARCH_HINTS.test(task)) s += 0.5;
    if (urlsIn(task).length) s += 0.4;
    return Math.min(1, s);
  }

  /* Build the queries this mission should hit the brain with. */
  queries(ctx) {
    const out = [ctx.task];
    for (const sub of (ctx.plan && ctx.plan.subtasks) || []) if (sub && sub !== ctx.task) out.push(sub);
    return out.slice(0, 4);
  }

  async run(ctx) {
    const queries = this.queries(ctx);
    const hits = [];
    const seen = new Set();
    for (const q of queries) {
      let found = [];
      try { found = brain.search(q, 6) || []; } catch (_) { found = []; }
      for (const h of found) {
        const key = `${h.kind}:${h.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(h);
      }
    }
    hits.sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = hits.slice(0, 8);

    /* External sources: crawl at most two URLs found in the mission text. */
    const crawled = [];
    const failed = [];
    if (ctx.allowWeb !== false) {
      for (const url of urlsIn(ctx.task).slice(0, 2)) {
        try {
          const note = await weblearn.learnFromUrl(url);
          crawled.push({ url, title: note.title, snippet: snippet(note.content, 240) });
        } catch (e) {
          failed.push({ url, error: (e && e.message) || 'unreachable' });
        }
      }
    }

    /* Corpus stats give the Director an honest picture of how much evidence exists. */
    const db = dbm.load();
    const corpus = {
      notes: (db.notes || []).length,
      emails: (db.emails || []).length,
      messages: (db.messages || []).length,
      events: (db.events || []).length
    };

    ctx.shared.research = {
      queries,
      hits: top.map(h => ({ kind: h.kind, title: h.title, snippet: snippet(h.snippet, 200), score: h.score, ts: h.ts })),
      crawled,
      failed,
      corpus
    };

    const lines = [];
    lines.push(`Searched the second brain for: ${queries.map(q => `“${snippet(q, 60)}”`).join(', ')}.`);
    lines.push('');
    if (top.length) {
      lines.push(`**${top.length} relevant record${top.length === 1 ? '' : 's'} found:**`);
      top.forEach(h => lines.push(`- [${h.kind}] **${h.title}** — ${snippet(h.snippet, 160)}`));
    } else {
      lines.push(`No matching records yet — the brain holds ${corpus.notes} notes, ${corpus.emails} emails, ${corpus.messages} messages. Teach ARIA with “remember that …” or ingest a document to deepen this answer.`);
    }
    if (crawled.length) {
      lines.push('');
      lines.push('**External sources read:**');
      crawled.forEach(c => lines.push(`- **${c.title}** (${c.url}) — ${c.snippet}`));
    }
    if (failed.length) {
      lines.push('');
      failed.forEach(f => lines.push(`- Could not read ${f.url} — ${f.error}`));
    }

    return this.step(
      `Searched the second brain (${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}) and read ${crawled.length} external page${crawled.length === 1 ? '' : 's'}`,
      lines.join('\n'),
      { hits: top.length, crawled: crawled.length, corpus }
    );
  }
}

module.exports = ResearcherAgent;
