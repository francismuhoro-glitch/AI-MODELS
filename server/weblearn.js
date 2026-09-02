'use strict';
/* Learn from a website — server-side fetch + regex text extraction, ZERO new dependencies.
   Shared by POST /api/notes/from-url and the assistant's "read this website …" intent.
   Personal-scale tool: reads one https page and saves its readable text into the second brain. */
const brain = require('./brain');
const dbm = require('./db');

const MAX_TEXT = 12000; // ~3-4 pages of text — plenty for a note, keeps the brain light

function extract(html) {
  const src = String(html || '');
  const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const text = src
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|template|iframe|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&(?:#0?39|apos);/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: String(title).trim(), text };
}

async function learnFromUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '').trim()); } catch (_) { throw new Error('that does not look like a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('only https URLs are supported');
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
    headers: { 'user-agent': 'ARIA-OS-brain/1.0 (+personal local assistant)' }
  });
  if (!res.ok) throw new Error('the page answered HTTP ' + res.status);
  const { title, text } = extract(await res.text());
  if (!text) throw new Error('no readable text found (PDF, image or empty page)');
  const note = brain.ingestNote({
    title: title || ('Web page — ' + url.hostname),
    content: text.slice(0, MAX_TEXT),
    source: 'web',
    tags: ['web', url.hostname]
  });
  brain.buildIndex();
  await dbm.saveNow();
  return note;
}

module.exports = { learnFromUrl, extract };
