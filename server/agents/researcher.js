'use strict';
/* ResearcherAgent — queries the second brain, crawls external URLs, performs live web
   searches, and gathers facts for the swarm to reason over. */

const brain = require('../brain');
const dbm = require('../db');
const weblearn = require('../weblearn');
const websearch = require('../websearch');
const { Agent, urlsIn, snippet } = require('./base');

const RESEARCH_HINTS = /\b(research|find|look ?up|investigate|gather|source|evidence|facts?|what do (?:we|i) know|background|context|notes?|supplier|competitor|market|read|crawl|scan)\b/i;

class ResearcherAgent extends Agent {
  constructor() {
    super({
      id: 'researcher',
      name: 'ResearcherAgent',
      emoji: '🔎',
      role: 'Research & retrieval',
      description: 'Queries the second brain, crawls external URLs, performs live web searches and gathers the facts the rest of the swarm reasons over.',
      skills: ['second-brain search', 'web crawling', 'live web search', 'fact extraction']
    });
  }

  relevance(task) {
    let s = 0.35;                                   // research is almost always useful
    if (RESEARCH_HINTS.test(task)) s += 0.5;
    if (urlsIn(task).length) s += 0.4;
    // Boost relevance for queries that look like they need external knowledge
    if (/what\s+is|who\s+is|latest|news|tell me about|search|look up/i.test(task)) s += 0.3;
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
      /* Hybrid retrieval: BM25 plus embeddings when a backend is live, so a mission phrased
         differently from the notes ("who sells cement?" → supplier notes) still finds them. */
      try { found = (await brain.searchAsync(q, 6)) || []; } catch (_) { try { found = brain.search(q, 6) || []; } catch (__) { found = []; } }
      for (const h of found) {
        const key = `${h.kind}:${h.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(h);
      }
    }
    hits.sort((a, b) => ((b.blended || 0) - (a.blended || 0)) || ((b.score || 0) - (a.score || 0)));
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

    /* Live web search — if brain results are thin or mission looks like it needs external knowledge. */
    const webResults = [];
    const HIGH_CONFIDENCE = 3.0;
    const HIGH_CONFIDENCE_SEMANTIC = 0.55;
    const hasStrongBrainHits = top.some(h => (h.score || 0) >= HIGH_CONFIDENCE || (h.semantic || 0) >= HIGH_CONFIDENCE_SEMANTIC);
    const needsWebKnowledge = !hasStrongBrainHits || /what\s+is|who\s+is|latest|news|github|tell me about/i.test(ctx.task);

    if (ctx.allowWeb !== false && needsWebKnowledge) {
      try {
        const searchResults = await websearch.searchWeb(ctx.task, 3);
        if (searchResults && searchResults.length > 0) {
          for (const r of searchResults) {
            webResults.push({
              title: r.title,
              snippet: snippet(r.snippet, 240),
              url: r.url,
              source: r.source
            });
          }
          // Ingest top web result into second brain in background
          if (searchResults[0].url && searchResults[0].url.startsWith('http')) {
            weblearn.learnFromUrl(searchResults[0].url).catch(() => {});
          }
        }
      } catch (_) {}
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
      hits: top.map(h => ({ kind: h.kind, title: h.title, snippet: snippet(h.snippet, 200), score: h.score, semantic: h.semantic || 0, ts: h.ts })),
      crawled,
      failed,
      webResults,
      corpus
    };

    const lines = [];
    lines.push(`Searched the second brain for: ${queries.map(q => `"${snippet(q, 60)}"`).join(', ')}.`);
    lines.push('');
    if (top.length) {
      lines.push(`**${top.length} relevant record${top.length === 1 ? '' : 's'} found in brain:**`);
      top.forEach(h => lines.push(`- [${h.kind}] **${h.title}** — ${snippet(h.snippet, 160)}`));
    } else {
      lines.push(`No matching records in brain — ${corpus.notes} notes, ${corpus.emails} emails, ${corpus.messages} messages.`);
    }
    if (crawled.length) {
      lines.push('');
      lines.push('**External pages read:**');
      crawled.forEach(c => lines.push(`- **${c.title}** (${c.url}) — ${c.snippet}`));
    }
    if (failed.length) {
      lines.push('');
      failed.forEach(f => lines.push(`- Could not read ${f.url} — ${f.error}`));
    }
    if (webResults.length) {
      lines.push('');
      lines.push(`**🌐 Live web search found ${webResults.length} result${webResults.length === 1 ? '' : 's'}:**`);
      webResults.forEach(r => lines.push(`- [${r.source}] **${r.title}** — ${r.snippet}\n  🔗 ${r.url}`));
    }

    return this.step(
      `Searched brain (${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}), crawled ${crawled.length} page${crawled.length === 1 ? '' : 's'}${webResults.length ? ', found ' + webResults.length + ' web result' + (webResults.length === 1 ? '' : 's') : ''}`,
      lines.join('\n'),
      { hits: top.length, crawled: crawled.length, webResults: webResults.length, corpus }
    );
  }
}

module.exports = ResearcherAgent;
