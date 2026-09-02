'use strict';
/* Shared helpers: ids, time (Africa/Nairobi default), priority scoring, work vs business classification */

const crypto = require('crypto');

const uid = (p = 'id') => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function tzDate(ts, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ts)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
}

function dayKey(ts, timezone) { const p = tzDate(ts, timezone); return `${p.year}-${p.month}-${p.day}`; }

function timeStr(ts, timezone) { const p = tzDate(ts, timezone); return `${p.hour}:${p.minute}`; }

function dayLabel(ts, timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ts));
}

function minutesOfDay(ts, timezone) { const p = tzDate(ts, timezone); return (+p.hour) * 60 + (+p.minute); }

/* ---- Priority engine ---- */
const URGENT_WORDS = ['urgent', 'asap', 'immediately', 'critical', 'emergency', 'overdue', 'escalat', 'deadline', 'final notice', 'action required', 'time sensitive', 'today', 'eod', 'blocked'];
const MONEY_WORDS = ['invoice', 'payment', 'mpesa', 'bank', 'quote', 'quotation', 'invoice', 'pricing', 'budget', 'salary', 'invoice#', 'receipt', 'refund', 'deposit', 'purchase order', 'lpo'];
const BIZ_WORDS = ['invoice', 'mpesa', 'order', 'order', 'supplier', 'stock', 'delivery', 'customer', 'quotation', 'quote', 'lpo', 'shipment', 'inventory', 'sales', 'client order', 'restock'];
const ACTION_WORDS = ['please send', 'follow up', 'can you', 'kindly', 'need you to', 'review', 'approve', 'sign', 'submit', 'confirm', 'rsvp', 'reply', 'respond', 'by tomorrow', 'by friday', 'by monday', 'let me know', 'reminder'];

function scorePriority(item) {
  const text = `${item.subject || item.title || ''} ${item.text || item.body || item.snippet || ''}`.toLowerCase();
  let score = 0;
  for (const w of URGENT_WORDS) if (text.includes(w)) score += 4;
  for (const w of MONEY_WORDS) if (text.includes(w)) score += 2.5;
  for (const w of ACTION_WORDS) if (text.includes(w)) score += 1.5;
  if ((item.subject || '').length > 0 && item.subject === item.subject.toUpperCase() && /[A-Z]{4,}/.test(item.subject || '')) score += 2;
  const ageH = (Date.now() - (item.receivedAt || item.sentAt || Date.now())) / 36e5;
  if (ageH < 4) score += 2; else if (ageH < 24) score += 1;
  if (item.unread === false) score -= 1;
  return Math.round(score * 10) / 10;
}
const priorityOf = (score) => score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';

/* work vs business classification */
function classifyContext(item) {
  const text = `${item.subject || item.title || ''} ${item.text || item.body || item.snippet || ''} ${item.channel || ''}`.toLowerCase();
  let biz = 0;
  for (const w of BIZ_WORDS) if (text.includes(w)) biz += 2;
  if (item.calendar === 'Business') biz += 4;
  if (item.channel && /biz|business|sales|suppl|orders/i.test(item.channel)) biz += 3;
  return biz >= 4 ? 'business' : 'work';
}

/* Simple keyword topic extraction */
const STOP = new Set(('a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,their,our,your,my,me,not,no,yes,do,does,did,done,have,has,had,will,would,can,could,should,shall,may,might,must,about,into,over,after,before,under,up,down,out,off,again,further,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,only,own,same,so,than,too,very,just,also,get,got,please,thanks,thank,hi,hello,hey,dear,regards,best,kind,cheers,am,pm,today,tomorrow,yesterday,week,next,last,new,one,two,still,need,want,good,morning,afternoon,evening').split(','));

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !/^\d+$/.test(t) && !STOP.has(t));
}

function extractTopics(text, n = 5) {
  const freq = {};
  for (const t of tokenize(text)) freq[t] = (freq[t] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

function extractEntities(text) {
  const m = String(text || '').match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/g) || [];
  return [...new Set(m)].filter(w => !STOP.has(w.toLowerCase())).slice(0, 8);
}

function snippet(text, len = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/* ---- Timezone-aware wall-clock helpers (used by the autonomous planner) ----
   The owner's rhythm (wake 06:00, work 08:00–17:00) is expressed in their timezone,
   which is usually NOT the server's. These helpers convert "wall time in tz" → UTC ms. */
function tzOffsetMin(timezone, ts) {
  const p = tzDate(ts, timezone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUTC - Math.floor(ts / 60000) * 60000) / 60000);
}

/* UTC ms for `hour`:`minute` on the calendar day `key` (YYYY-MM-DD) in `timezone`. */
function zonedTime(key, hour, minute, timezone) {
  const [y, m, d] = String(key).split('-').map(Number);
  const guess = Date.UTC(y, (m || 1) - 1, d || 1, hour || 0, minute || 0);
  const off = tzOffsetMin(timezone, guess);
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(timezone, t);
  if (off2 !== off) t = guess - off2 * 60000;   // DST boundary
  return t;
}

function dayKeyAdd(key, days) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function dayKeyDow(key) { return new Date(String(key) + 'T12:00:00Z').getUTCDay(); }

/* ---- Basic profanity filter (web results + swarm outputs never ship raw profanity) ---- */
const PROFANITY_WORDS = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch',
  'ass', 'asshole', 'bastard', 'bollocks', 'bugger', 'crap', 'crappy', 'damn', 'dammit', 'goddamn',
  'dick', 'dickhead', 'piss', 'pissed', 'prick', 'cunt', 'twat', 'wanker', 'slut', 'whore',
  'dumbass', 'jackass', 'arse', 'arsehole', 'bloody hell'
];
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY_WORDS.join('|')})\\b`, 'gi');

/* Mask profanity, keeping the first letter so context stays readable ("s**t"). */
function cleanProfanity(text) {
  return String(text || '').replace(PROFANITY_RE, (m) => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { uid, slug, tzDate, dayKey, timeStr, dayLabel, minutesOfDay, scorePriority, priorityOf, classifyContext, tokenize, extractTopics, extractEntities, snippet, escapeHtml, tzOffsetMin, zonedTime, dayKeyAdd, dayKeyDow, cleanProfanity, PROFANITY_WORDS };
