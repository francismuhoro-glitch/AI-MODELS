'use strict';
const weblearn = require('./weblearn');

async function searchWeb(query, limit = 3) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const html = await res.text();
    
    const results = [];
    const linkRegex = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>/g;
    const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    
    let linkMatch, snippetMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null && results.length < limit) {
      let rawUrl = linkMatch[1];
      if (rawUrl.includes('uddg=')) {
        const parts = rawUrl.split('uddg=');
        if (parts[1]) rawUrl = decodeURIComponent(parts[1].split('&')[0]);
      }
      snippetMatch = snippetRegex.exec(html);
      const snippetText = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (rawUrl.startsWith('https://')) {
        results.push({ url: rawUrl, snippet: snippetText });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function searchAndIngest(query, limit = 2) {
  const links = await searchWeb(query, limit);
  const notes = [];
  for (const item of links) {
    try {
      const note = await weblearn.learnFromUrl(item.url);
      if (note) notes.push(note);
    } catch (_) {}
  }
  return notes;
}

module.exports = { searchWeb, searchAndIngest };
