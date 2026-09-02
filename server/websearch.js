'use strict';
/**
 * Web Search Subsystem — multi-source, zero-dependency, serverless-safe.
 *
 * Sources (in priority order):
 *   1. DuckDuckGo Instant Answer API  (JSON, fast, no scraping)
 *   2. Wikipedia REST API             (definitions, biographies, factual knowledge)
 *   3. DuckDuckGo Lite HTML parser    (fallback when JSON APIs return nothing)
 *
 * All network calls respect a 4-second total timeout budget so the module is safe
 * on Vercel serverless (10 s hard limit with cold-start overhead).
 */
const weblearn = require('./weblearn');

const BUDGET_MS = 4000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ─── DuckDuckGo Instant Answer API (JSON) ─────────────────────────────── */
async function searchDuckDuckGoInstant(query) {
  try {
    const q = encodeURIComponent(query);
    const res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(BUDGET_MS)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const results = [];

    // Abstract (main answer)
    if (json.AbstractText) {
      results.push({
        title: json.Heading || query,
        snippet: json.AbstractText,
        url: json.AbstractURL || `https://duckduckgo.com/?q=${q}`,
        source: 'duckduckgo-instant'
      });
    }

    // Related topics
    const topics = (json.RelatedTopics || []).filter(t => t.Text && t.FirstURL);
    for (const t of topics.slice(0, 4)) {
      results.push({
        title: (t.Text || '').split(' - ')[0].slice(0, 100),
        snippet: t.Text || '',
        url: t.FirstURL || '',
        source: 'duckduckgo-instant'
      });
    }

    // Answer (for things like "what is the population of…")
    if (json.Answer) {
      results.unshift({
        title: query,
        snippet: String(json.Answer),
        url: json.AbstractURL || `https://duckduckgo.com/?q=${q}`,
        source: 'duckduckgo-instant'
      });
    }

    // Definition
    if (json.Definition) {
      results.push({
        title: json.Heading || query,
        snippet: json.Definition,
        url: json.DefinitionURL || `https://duckduckgo.com/?q=${q}`,
        source: 'duckduckgo-instant'
      });
    }

    return results;
  } catch (_) {
    return [];
  }
}

/* ─── Wikipedia REST API ───────────────────────────────────────────────── */
async function searchWikipedia(query, limit = 2) {
  try {
    const q = encodeURIComponent(query);
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=${limit}&format=json&origin=*`,
      {
        headers: { 'User-Agent': 'ARIA-OS-brain/1.0 (+personal assistant)', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(BUDGET_MS)
      }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const items = (json.query && json.query.search) || [];

    // Fetch excerpts for top results in parallel (within budget)
    const titles = items.map(i => i.title);
    let excerpts = {};
    if (titles.length) {
      try {
        const exRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[0])}`,
          {
            headers: { 'User-Agent': 'ARIA-OS-brain/1.0 (+personal assistant)', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(2000)
          }
        );
        if (exRes.ok) {
          const exJson = await exRes.json();
          excerpts[titles[0]] = exJson.extract || '';
        }
      } catch (_) {}
    }

    return items.map(item => ({
      title: item.title,
      snippet: excerpts[item.title] || item.snippet.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      source: 'wikipedia'
    }));
  } catch (_) {
    return [];
  }
}

/* ─── DuckDuckGo Lite HTML Parser (fallback) ──────────────────────────── */
async function searchDuckDuckGo(query) {
  const q = encodeURIComponent(query);
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${q}`,
    `https://lite.duckduckgo.com/lite/?q=${q}`
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(BUDGET_MS)
      });
      if (!res.ok) continue;
      const html = await res.text();

      const results = [];
      const linkRegex = /<a[^>]*class="(?:result__url|result-link|result__a)"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<(?:a|td|div)[^>]*class="(?:result__snippet|result-snippet)"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;

      let lm;
      while ((lm = linkRegex.exec(html)) !== null && results.length < 4) {
        let rawUrl = lm[1];
        if (rawUrl.includes('uddg=')) {
          rawUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]);
        }
        const title = lm[2].replace(/<[^>]+>/g, '').trim();
        if (rawUrl.startsWith('http') && !rawUrl.includes('duckduckgo.com') && title) {
          results.push({ url: rawUrl, title, snippet: '', source: 'duckduckgo-html' });
        }
      }

      let sm, i = 0;
      while ((sm = snippetRegex.exec(html)) !== null && i < results.length) {
        const snip = sm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        results[i].snippet = snip;
        i++;
      }

      const valid = results.filter(r => r.title);
      if (valid.length > 0) return valid;
    } catch (_) {}
  }
  return [];
}

/* ─── Unified multi-source search ──────────────────────────────────────── */
/**
 * Search the web across multiple sources with a 4-second total timeout.
 * @param {string} query
 * @param {number} [limit=3]
 * @returns {Promise<Array<{title: string, snippet: string, url: string, source: string}>>}
 */
async function searchWeb(query, limit = 3) {
  const q = String(query || '').trim();
  if (!q) return [];

  const startTime = Date.now();
  const remaining = () => Math.max(200, BUDGET_MS - (Date.now() - startTime));

  // Race all sources but enforce the global budget
  const sources = [
    searchDuckDuckGoInstant(q),
    searchWikipedia(q, 2),
    // Only try HTML parser if we still have budget after 1.5s
    new Promise(resolve => {
      const delay = Math.min(1500, remaining() - 500);
      setTimeout(() => {
        searchDuckDuckGo(q).then(resolve).catch(() => resolve([]));
      }, Math.max(0, delay));
    })
  ];

  try {
    const allResults = await Promise.allSettled(sources);
    let merged = [];
    const seenUrls = new Set();

    for (const result of allResults) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        for (const r of result.value) {
          if (r && r.title && !seenUrls.has(r.url)) {
            seenUrls.add(r.url);
            merged.push({
              title: r.title,
              snippet: r.snippet || '',
              url: r.url || '',
              source: r.source || 'unknown'
            });
          }
        }
      }
    }

    return merged.slice(0, limit);
  } catch (_) {
    return [];
  }
}

/**
 * Search the web, fetch the top result via weblearn, and persist into the second brain.
 * @param {string} query
 * @param {number} [limit=1]
 * @returns {Promise<Array<{title: string, snippet: string, url: string, source: string}>>}
 */
async function searchAndIngest(query, limit = 1) {
  const results = await searchWeb(query, Math.max(limit, 1));
  for (const r of results.slice(0, limit)) {
    if (r.url && r.url.startsWith('http')) {
      try { await weblearn.learnFromUrl(r.url); } catch (_) {}
    }
  }
  return results;
}

module.exports = { searchWeb, searchAndIngest, searchDuckDuckGo, searchDuckDuckGoInstant, searchWikipedia };
