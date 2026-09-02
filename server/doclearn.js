'use strict';
const brain = require('./brain');
const dbm = require('./db');
const { snippet } = require('./util');

function extractPdfText(buffer) {
  try {
    const raw = buffer.toString('binary');
    const texts = [];
    const streamRegex = /stream([\r\n]+)([\s\S]*?)[\r\n]+endstream/g;
    let match;
    while ((match = streamRegex.exec(raw)) !== null) {
      const block = match[2];
      const strRegex = /\(([^\)]+)\)\s*Tj/g;
      let strMatch;
      while ((strMatch = strRegex.exec(block)) !== null) {
        texts.push(strMatch[1]);
      }
    }
    const extracted = texts.join(' ').replace(/\\([\(\)])/g, '$1').trim();
    if (extracted.length > 20) return extracted;
  } catch (_) {}
  return buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function ingestDocument(filename, contentBuffer, mimeType = '') {
  let text = '';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  
  if (ext === 'pdf' || mimeType.includes('pdf')) {
    text = extractPdfText(contentBuffer);
  } else if (['csv', 'txt', 'md', 'json', 'log'].includes(ext) || mimeType.includes('text')) {
    text = contentBuffer.toString('utf8');
  } else {
    text = contentBuffer.toString('utf8');
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text.length < 5) throw new Error('Could not extract readable text from document');

  const title = filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
  const note = brain.ingestNote({
    title: `📄 ${title}`,
    content: text.slice(0, 16000),
    source: 'document',
    tags: ['document', ext || 'file']
  });

  brain.buildIndex();
  await dbm.saveNow();
  return note;
}

module.exports = { ingestDocument };
