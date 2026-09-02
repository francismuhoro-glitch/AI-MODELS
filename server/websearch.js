'use strict';
const weblearn = require('./weblearn');

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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(5000)
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
          results.push({ url: rawUrl, title, snippet: '' });
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

async function searchAndIngest(query, limit = 2) {
  const results = await searchDuckDuckGo(query);
  for (const r of results.slice(0, limit)) {
    try { await weblearn.learnFromUrl(r.url); } catch (_) {}
  }
  return results;
}

module.exports = { searchDuckDuckGo, searchAndIngest };
