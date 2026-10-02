'use strict';
/* PHRASE DICTIONARY + LANGUAGE POLICY — Swahili, Kikuyu, Sheng and English.
   ═══════════════════════════════════════════════════════════════════════════════════════════
   WHAT THIS IS
     One editable store of phrases (seeded, then fully user-editable through /api/dictionary and
     Settings → 🗣️ Language & phrases) that does three jobs:
       1. NORMALIZATION — a Swahili/Sheng/Kikuyu command at the start of a message is rewritten
          into the English phrasing the existing deterministic intent layer already understands
          ("weka kengele kesho asubuhi" → "set an alarm tomorrow morning"). No LLM needed.
       2. GROUNDING — the same entries are injected into the LLM system prompt, so ARIA
          understands idiomatic phrases and Kenyan code-switching even when the base model has
          weak Swahili/Kikuyu token representations.
       3. LANGUAGE POLICY — one place that answers "which STT locale / TTS voice should this
          device use?", honestly: browsers recognise Swahili but NOT Kikuyu.
   HONEST LIMITS (surfaced in the UI, the API and docs/DURABLE_LEARNING.md's sibling doc):
     • Browser speech recognition (Web Speech API) has no Kikuyu model. With Kikuyu active the
       mic is disabled and badged; typed Kikuyu and dictionary-matched phrases still work.
     • Dictionary matching is deterministic phrase→command mapping, not translation. Time words
       (leo/kesho/jana/asubuhi/jioni/usiku) are substituted best-effort; longer Swahili/Kikuyu
       sentences still go to the model, which may answer in the wrong language — the language
       block tells it not to invent Kikuyu it does not know.
*/
const store = require('./store');
const cfgm = require('./config');
const permissions = require('./permissions');
const { uid } = require('./util');

const DOC_ID = 'dictionary';

/* Language codes used across the store. 'sheng' is Kenyan street Swahili (code-switching). */
const LANGUAGES = ['en', 'sw', 'ki', 'sheng'];
const MODES = ['auto', 'en', 'sw', 'ki'];

/* STT: what a browser can actually be asked for. Kikuyu is deliberately EMPTY — no browser
   ships a Kikuyu recognition model (documented; the mic degrades to typed input). */
const STT_LOCALES = {
  en: ['en-KE', 'en-US', 'en-GB'],
  sw: ['sw-KE', 'sw-TZ', 'sw'],
  ki: [],
  /* 'auto' means "use the device/browser default (navigator.language)" — no override. */
  auto: []
};
/* TTS: the locale families a voice picker should look for, best first (glob-ish, for humans
   and the client). The client has its own regex table for the actual pick. */
const TTS_PREFERENCE = {
  en: ['en-KE', 'en-US', 'en-GB', 'en*'],
  sw: ['sw-KE', 'sw-TZ', 'sw*', 'en-KE', 'en*'],
  ki: ['ki*', 'sw-KE', 'sw*', 'en-KE', 'en*'],
  auto: ['en-KE', 'en-US', 'en-GB', 'en*']
};

/* Best-effort time/date words for the normalized command (Swahili + Sheng + Kikuyu). */
const TIME_WORDS = [
  [/\bsasa hivi\b/gi, 'now'], [/\bkesho\b/gi, 'tomorrow'], [/\bleo\b/gi, 'today'],
  [/\bjana\b/gi, 'yesterday'], [/\basubuhi\b/gi, 'morning'], [/\bmchana\b/gi, 'afternoon'],
  [/\bjioni\b/gi, 'evening'], [/\busiku\b/gi, 'night'], [/\bbaadaye\b/gi, 'later'],
  [/\brũcinĩ\b/gi, 'evening'], [/\bruthiomi\b/gi, 'night'], [/\bũmĩthĩ\b/gi, 'morning'],
  [/\bumithi\b/gi, 'morning'], [/\brũciĩ\b/gi, 'today']
];

/* Intents whose replies are deterministic scripts (never a hallucinated action). */
const SOFT_INTENTS = new Set(['greeting', 'acknowledge', 'thanks', 'goodbye', 'help', 'call', 'media-unsupported']);

/* ── scripted replies, per language. Kikuyu deliberately falls back to Swahili (documented). ── */
const SCRIPTS = {
  greeting: {
    en: () => 'Hello! ARIA here — what are we working on?',
    sw: () => 'Habari! Niko tayari — nikuongoze kwa nini?',
    ki: () => 'Nĩ wega! Nijibu kwa Kiswahili kwa sababu Kikuyu yangu ni ndogo — unaweza kuongeza misemo yako kwenye Settings.'
  },
  acknowledge: {
    en: () => 'Got it.',
    sw: () => 'Sawa.',
    ki: () => 'Nĩ wega. (Natumia Kiswahili — ongeza misemo yako kwenye Settings.)'
  },
  thanks: {
    en: () => 'Any time — that is what I am here for.',
    sw: () => 'Karibu! Niko hapa kila wakati.',
    ki: () => 'Karibu! (Natumia Kiswahili — Kikuyu yangu ni ndogo.)'
  },
  goodbye: {
    en: () => 'Talk soon — I will keep an eye on your day.',
    sw: () => 'Kwaheri! Nitaendelea kuangalia ratiba yako.',
    ki: () => 'Thiĩ na wega! (Natumia Kiswahili — Kikuyu yangu ni ndogo.)'
  },
  help: {
    en: () => 'I can plan your day, set alarms and reminders, add tasks, play or pause music, search your calendar, notes and email, and remember what matters. Say it in English, Swahili or Sheng — Kikuyu works by typing (browsers cannot recognise Kikuyu speech).',
    sw: () => 'Naweza kupanga siku yako, kuweka kengele na kumbukumbu, kuongeza kazi, kucheza au kusimamisha muziki, kutafuta kwenye kalenda, noti na barua pepe, na kukumbuka mambo muhimu. Sema kwa Kiswahili, Kiingereza au Sheng — Kikuyu inafanya kazi kwa kuandika (browseri haiwezi kutambua sauti ya Kikuyu).',
    ki: () => 'Naweza kupanga siku yako, kuweka kengele, kuongeza kazi na kucheza muziki. Sema kwa Kiswahili au Kiingereza — Kikuyu inafanya kazi kwa kuandika tu.'
  },
  call: {
    en: (rest) => `I cannot place calls from here — ARIA OS has no dialler (the phone bridge handles alarms, media and opening apps only). I can set a reminder to call ${rest || 'them'} or draft a message instead.`,
    sw: (rest) => `Siwezi kupiga simu moja kwa moja — ARIA OS haina kipiga simu (daraja la simu linashughulikia kengele, muziki na kufungua programu tu). Naweza kuweka kumbukumbu ya kumpigia ${rest || 'yeye'} au kuandika ujumbe.`,
    ki: (rest) => `Siwezi kupiga simu moja kwa moja. Naweza kuweka kumbukumbu ya kumpigia ${rest || 'yeye'} au kuandika ujumbe. (Natumia Kiswahili — Kikuyu yangu ni ndogo.)`
  },
  'media-unsupported': {
    en: () => 'That media action is not wired to a player yet — the Android bridge handles real device playback when it is enabled.',
    sw: () => 'Kitendo hicho cha muziki hakijaunganishwa na kicheza sauti bado — daraja la Android linashughulikia uchezaji halisi linapowekwa.',
    ki: () => 'Kitendo hicho cha muziki hakijaunganishwa bado. (Natumia Kiswahili.)'
  }
};

/* ─────────────────────────── seed phrases ───────────────────────────
   Seeds are written to the store once; after that the owner owns them: every entry can be
   edited, disabled or deleted from Settings, and POST /api/dictionary/reset restores them. */
const SEED = [
  /* Greetings & social — Swahili */
  { phrase: 'habari ya asubuhi', lang: 'sw', intent: 'greeting', note: 'good morning' },
  { phrase: 'habari ya jioni', lang: 'sw', intent: 'greeting', note: 'good evening' },
  { phrase: 'habari', lang: 'sw', intent: 'greeting', note: 'hello / how are you' },
  { phrase: 'asante sana', lang: 'sw', intent: 'thanks', note: 'thank you very much' },
  { phrase: 'asante', lang: 'sw', intent: 'thanks', note: 'thank you' },
  { phrase: 'kwaheri', lang: 'sw', intent: 'goodbye', note: 'goodbye' },
  { phrase: 'tafadhali', lang: 'sw', intent: 'acknowledge', note: 'please (politeness)' },
  /* Greetings & social — Sheng (Kenyan code-switching) */
  { phrase: 'mambo vipi', lang: 'sheng', intent: 'greeting', note: "what's up" },
  { phrase: 'mambo', lang: 'sheng', intent: 'greeting', note: "what's up" },
  { phrase: 'sasa', lang: 'sheng', intent: 'greeting', note: 'hey / what is up' },
  { phrase: 'niaje', lang: 'sheng', intent: 'greeting', note: 'how are things' },
  { phrase: 'sema', lang: 'sheng', intent: 'greeting', note: 'talk to me / go ahead' },
  { phrase: 'vipi', lang: 'sheng', intent: 'greeting', note: 'how is it going' },
  { phrase: 'poa', lang: 'sheng', intent: 'acknowledge', note: 'cool / all good' },
  /* Greetings & social — Kikuyu (idioms only; recognition is documented as unavailable) */
  { phrase: 'wĩ mwega', lang: 'ki', intent: 'greeting', note: 'you are good (Kikuyu greeting)' },
  { phrase: 'wi mwega', lang: 'ki', intent: 'greeting', note: 'you are good (Kikuyu greeting, no diacritics)' },
  { phrase: 'ũhoro waku', lang: 'ki', intent: 'greeting', note: 'how are you (singular)' },
  { phrase: 'uhoro waku', lang: 'ki', intent: 'greeting', note: 'how are you (singular, no diacritics)' },
  { phrase: 'nĩ wega', lang: 'ki', intent: 'acknowledge', note: 'it is good / I am fine' },
  { phrase: 'ni wega', lang: 'ki', intent: 'acknowledge', note: 'it is good / I am fine (no diacritics)' },
  { phrase: 'ndĩ mwega', lang: 'ki', intent: 'acknowledge', note: 'I am fine' },
  { phrase: 'ndi mwega', lang: 'ki', intent: 'acknowledge', note: 'I am fine (no diacritics)' },
  { phrase: 'ũmĩthĩ mwega', lang: 'ki', intent: 'greeting', note: 'good morning' },
  { phrase: 'umithi mwega', lang: 'ki', intent: 'greeting', note: 'good morning (no diacritics)' },
  { phrase: 'kĩhana', lang: 'ki', intent: 'greeting', note: "what's happening" },
  { phrase: 'kihana', lang: 'ki', intent: 'greeting', note: "what's happening (no diacritics)" },
  { phrase: 'ngatho', lang: 'ki', intent: 'thanks', note: 'thank you' },
  { phrase: 'thiĩ na wega', lang: 'ki', intent: 'goodbye', note: 'go well' },
  { phrase: 'thii na wega', lang: 'ki', intent: 'goodbye', note: 'go well (no diacritics)' },
  { phrase: 'tiga', lang: 'ki', intent: 'media-pause', command: 'pause the music', note: 'stop / leave it' },
  /* Commands — Swahili. '{rest}' keeps whatever followed the phrase. */
  { phrase: 'panga siku yangu', lang: 'sw', intent: 'plan', command: 'plan my day', note: 'plan my day' },
  { phrase: 'panga siku', lang: 'sw', intent: 'plan', command: 'plan my day', note: 'plan my day' },
  { phrase: 'weka kengele', lang: 'sw', intent: 'alarm-set', command: 'set an alarm {rest}', note: 'set an alarm' },
  { phrase: 'weka alarm', lang: 'sw', intent: 'alarm-set', command: 'set an alarm {rest}', note: 'set an alarm' },
  { phrase: 'niamshe', lang: 'sw', intent: 'alarm-set', command: 'set an alarm {rest}', note: 'wake me up' },
  { phrase: 'nikumbushe', lang: 'sw', intent: 'remind', command: 'remind me to {rest}', note: 'remind me' },
  { phrase: 'kumbusha', lang: 'sw', intent: 'remind', command: 'remind me to {rest}', note: 'remind' },
  { phrase: 'ongeza kazi', lang: 'sw', intent: 'task-add', command: 'add task {rest}', note: 'add a task' },
  { phrase: 'orodha ya kazi', lang: 'sw', intent: 'priorities-query', command: 'what are my priorities?', note: 'my task list' },
  { phrase: 'kazi zangu', lang: 'sw', intent: 'priorities-query', command: 'what are my priorities?', note: 'my tasks' },
  { phrase: 'ratiba ya leo', lang: 'sw', intent: 'schedule-query', command: "what's on my calendar today?", note: "today's schedule" },
  { phrase: 'ratiba yangu', lang: 'sw', intent: 'schedule-query', command: "what's on my calendar today?", note: 'my schedule' },
  { phrase: 'panga mkutano', lang: 'sw', intent: 'schedule-create', command: 'schedule a meeting {rest}', note: 'schedule a meeting' },
  { phrase: 'piga simu kwa', lang: 'sw', intent: 'call', note: 'call … (ARIA cannot dial — offers a reminder)' },
  { phrase: 'cheza muziki', lang: 'sw', intent: 'media-play', command: 'play music {rest}', note: 'play music' },
  { phrase: 'cheza', lang: 'sw', intent: 'media-play', command: 'play music {rest}', note: 'play (music)' },
  { phrase: 'simamisha muziki', lang: 'sw', intent: 'media-pause', command: 'pause the music', note: 'pause the music' },
  { phrase: 'wimbo unaofuata', lang: 'sw', intent: 'media-next', command: 'next track', note: 'next track' },
  { phrase: 'wimbo uliopita', lang: 'sw', intent: 'media-previous', command: 'previous track', note: 'previous track' },
  { phrase: 'weka sauti', lang: 'sw', intent: 'media-volume', command: 'volume {rest}', note: 'set the volume' },
  { phrase: 'sahau', lang: 'sw', intent: 'memory-forget', command: 'forget that', note: 'forget that' },
  { phrase: 'kumbuka', lang: 'sw', intent: 'memory-remember', command: 'remember that {rest}', note: 'remember that …' },
  { phrase: 'msaada', lang: 'sw', intent: 'help', note: 'help' },
  { phrase: 'ndiyo', lang: 'sw', intent: 'confirm', command: 'yes', note: 'yes' },
  { phrase: 'hapana', lang: 'sw', intent: 'cancel', command: 'cancel the plan', note: 'no' }
];

const clean = (s) => String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ');
const fold = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();

/* Leading words that may precede a phrase without breaking the match ("hey ARIA, habari"). */
const LEAD_OK = new Set(['aria', 'hey', 'hi', 'hello', 'please', 'tafadhali', 'jamani', 'bwana', 'ok', 'okay', 'so', 'well']);

function normalizeEntry(raw, existing) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const phrase = clean(e.phrase);
  if (!phrase || phrase.length > 120) return { error: 'phrase is required (max 120 characters)' };
  if (!LANGUAGES.includes(String(e.lang || ''))) return { error: `lang must be one of ${LANGUAGES.join(', ')}` };
  const command = clean(e.command);
  return {
    id: existing ? existing.id : (String(e.id || '').startsWith('phrase_') ? e.id : uid('phrase')),
    phrase,
    lang: String(e.lang),
    intent: clean(e.intent || 'custom').toLowerCase().slice(0, 40),
    command: command.slice(0, 160),
    note: clean(e.note).slice(0, 160),
    enabled: e.enabled !== false,
    source: existing ? (existing.source || 'user') : 'user',
    hits: existing ? Number(existing.hits || 0) : 0,
    updatedAt: Date.now()
  };
}

let cache = null;

function seedEntries() {
  return SEED.map((s) => ({
    id: uid('phrase'), phrase: s.phrase, lang: s.lang, intent: s.intent, command: s.command || '',
    note: s.note || '', enabled: true, source: 'seed', hits: 0, updatedAt: Date.now()
  }));
}

function load() {
  if (cache) return cache;
  let doc = null;
  try { doc = store.docGetSync(DOC_ID); } catch (_) { doc = null; }
  const entries = doc && Array.isArray(doc.entries) ? doc.entries : null;
  cache = { entries: entries && entries.length ? entries.map((e) => normalizeEntry(e, e)).filter((e) => !e.error) : seedEntries() };
  if (!entries) { try { store.docSet(DOC_ID, cache).catch(() => {}); } catch (_) {} }
  return cache;
}

async function persist() {
  try { await store.docSet(DOC_ID, cache); } catch (_) { /* read-only fs / offline store: keep in memory */ }
  return cache;
}

/** All entries (optionally filtered by lang / enabled). */
function list(opts = {}) {
  let out = load().entries.slice();
  if (opts.lang) out = out.filter((e) => e.lang === String(opts.lang));
  if (opts.enabledOnly) out = out.filter((e) => e.enabled);
  return out.sort((a, b) => (a.lang === b.lang ? a.phrase.localeCompare(b.phrase) : String(a.lang).localeCompare(String(b.lang))));
}

async function add(raw) {
  const entry = normalizeEntry(raw, null);
  if (entry.error) return { error: entry.error };
  const dup = load().entries.find((e) => fold(e.phrase) === fold(entry.phrase) && e.lang === entry.lang);
  if (dup) return { error: `that phrase already exists (${dup.intent})`, duplicate: dup };
  load().entries.push(entry);
  await persist();
  permissions.audit({ integration: 'dictionary', action: 'add', status: 'ok', summary: `added ${entry.lang} phrase "${entry.phrase}"`, target: entry.id });
  return entry;
}

async function update(id, patch) {
  const cur = load().entries.find((e) => e.id === id);
  if (!cur) return null;
  const next = normalizeEntry({ ...cur, ...(patch || {}) }, cur);
  if (next.error) return { error: next.error };
  const i = load().entries.findIndex((e) => e.id === id);
  next.source = cur.source;
  load().entries[i] = next;
  await persist();
  permissions.audit({ integration: 'dictionary', action: 'update', status: 'ok', summary: `updated phrase "${next.phrase}"`, target: id });
  return next;
}

async function remove(id) {
  const before = load().entries.length;
  const gone = load().entries.find((e) => e.id === id) || null;
  cache.entries = load().entries.filter((e) => e.id !== id);
  if (cache.entries.length === before) return { deleted: 0 };
  await persist();
  permissions.audit({ integration: 'dictionary', action: 'delete', status: 'ok', summary: `deleted phrase "${gone ? gone.phrase : id}"`, target: id });
  return { deleted: 1, entry: gone };
}

async function reset() {
  /* Seeds are rebuilt; the owner's own phrases survive. An EDITED seed reverts to its
     original text — that is the point of a reset. */
  const custom = load().entries.filter((e) => e.source !== 'seed');
  cache = { entries: [...seedEntries(), ...custom] };
  await persist();
  permissions.audit({ integration: 'dictionary', action: 'reset', status: 'ok', summary: `restored ${cache.entries.length} seed phrases` });
  return cache.entries;
}

/**
 * EVERY dictionary phrase in the message, in reading order, longest-first on overlap.
 * Whole-word boundaries only; a phrase may be preceded by filler words ("hey ARIA,") or by
 * another matched phrase ("habari, weka kengele"), but not by unexplained English words — so
 * a sentence that merely contains a Swahili word in the middle is never hijacked.
 */
function matchAll(text) {
  const raw = clean(text);
  if (!raw) return [];
  /* ONE canonical string for both searching and slicing — `fold` strips punctuation and
     diacritics, so slicing the ORIGINAL with folded indices drifts ("habari, weka kengele"). */
  const low = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const found = [];
  for (const e of list({ enabledOnly: true })) {
    const p = fold(e.phrase);
    if (!p) continue;
    let from = 0;
    for (;;) {
      const idx = low.indexOf(p, from);
      if (idx < 0) break;
      from = idx + 1;
      const before = idx === 0 ? '' : low[idx - 1];
      const after = low[idx + p.length] || '';
      if (before && /[a-z0-9]/.test(before)) continue;
      if (after && /[a-z0-9]/.test(after)) continue;
      const rest = low.slice(idx + p.length).replace(/^[\s,.:;!?-]+/, '').trim();
      const command = normalizeTimeWords((e.command || '').replace(/\{rest\}/g, rest).replace(/\s+/g, ' ').trim());
      found.push({ entry: e, rest, command, index: idx, span: [idx, idx + p.length] });
    }
  }
  /* Overlapping entries ("habari" inside "habari ya asubuhi") keep only the longest. */
  found.sort((a, b) => (a.index - b.index) || (b.span[1] - b.span[0]) - (a.span[1] - a.span[0]));
  const kept = [];
  for (const c of found) {
    if (kept.some((k) => c.span[0] < k.span[1] && k.span[0] < c.span[1])) continue;
    const leadText = unmaskGap(low, kept, c.span[0]);
    const leadWords = leadText.split(/[^a-z0-9']+/).filter(Boolean);
    if (c.index !== 0 && !leadWords.every((w) => LEAD_OK.has(w) || /^\d+$/.test(w))) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/** The text before `upto` with everything already matched masked out (punctuation left). */
function unmaskGap(low, kept, upto) {
  let out = low.slice(0, upto);
  for (const k of kept) {
    if (k.span[1] > upto) continue;
    out = out.slice(0, k.span[0]) + ' '.repeat(k.span[1] - k.span[0]) + out.slice(k.span[1]);
  }
  return out.replace(/[^a-z0-9'\s]/g, ' ').trim();
}

/** The single best phrase match (longest at the earliest position), or null. */
function match(text) {
  const all = matchAll(text);
  return all.length ? all[0] : null;
}

/** Best-effort time/date word substitution applied to a normalized command. */
function normalizeTimeWords(text) {
  let out = String(text || '');
  for (const [re, word] of TIME_WORDS) out = out.replace(re, word);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Rewrite a message for the intent layer.
 * @returns {{text:string, matches:Array, original:string, note:string}}
 *   text = English phrasing when a phrase matched, otherwise the original message untouched.
 */
function apply(text) {
  const original = clean(text);
  const all = matchAll(original);
  if (!all.length) return { text: original, matches: [], original, rest: '', note: '' };
  const matches = all.map((h) => ({
    phrase: h.entry.phrase, lang: h.entry.lang, intent: h.entry.intent,
    note: h.entry.note, command: h.command, rest: h.rest
  }));
  /* An ACTIONABLE phrase always wins over a social one: "habari, weka kengele" is an alarm,
     not a greeting. Otherwise the earliest (longest) match leads. */
  const lead = all.find((h) => h.command) || all[0];
  lead.entry.hits = Number(lead.entry.hits || 0) + 1;   // usage counter is in-memory best effort
  const noteParts = all.map((h) => `"${h.entry.phrase}" (${h.entry.lang}) = ${h.entry.note || h.entry.intent}`);
  if (lead.command) {
    return {
      text: normalizeTimeWords(lead.command),
      matches,
      original,
      rest: lead.rest,
      note: `\n\n[PHRASE DICTIONARY: ${noteParts.join('; ')}${lead.rest ? `; the rest of the message ("${lead.rest}") follows it` : ''}. Reply to the user's meaning, not to this note.]`
    };
  }
  return {
    text: original,
    matches,
    original,
    rest: lead.rest,
    note: `\n\n[PHRASE DICTIONARY: ${noteParts.join('; ')}. Reply in the user's language.]`
  };
}

/* ─────────────────────────── language policy ─────────────────────────── */

function mode() {
  const m = String((cfgm.load().language || {}).mode || 'auto').toLowerCase();
  return MODES.includes(m) ? m : 'auto';
}

/** Which language should a REPLY to this message be in? (Kikuyu falls back to Swahili.) */
function replyLang(matchedLang) {
  const m = mode();
  if (m === 'en' || m === 'sw' || m === 'ki') return m === 'ki' ? 'ki' : m;
  const l = matchedLang && matchedLang !== 'sheng' ? matchedLang : (matchedLang === 'sheng' ? 'sw' : 'en');
  return l === 'ki' ? 'ki' : (l === 'sw' ? 'sw' : 'en');
}

/** Deterministic scripted reply for social intents — never invents an action. */
function scriptedReply(matched, langApp) {
  if (!matched || !matched.length) return null;
  if (!matched.every((m) => SOFT_INTENTS.has(m.intent))) return null;
  const first = matched[0];
  const script = SCRIPTS[first.intent];
  if (!script) return null;
  const rest = ((langApp && langApp.rest) || first.rest || '').trim();
  /* "habari" alone is a greeting; "habari, weka kengele" is a command handled elsewhere.
     A call keeps its target ("piga simu kwa Kamau") because the script needs the name. */
  if (rest && first.intent !== 'call') return null;
  const reply = (script[replyLang(first.lang)] || script.en)(rest);
  return { reply, intent: `dictionary-${first.intent}`, phrase: first.phrase, language: replyLang(first.lang) };
}

/** The STT locale a browser should be asked for — null when the browser cannot do it. */
function sttLocale(m) {
  const wanted = MODES.includes(m) ? m : mode();
  const explicit = clean((cfgm.load().language || {}).sttLocale || '');
  if (explicit && (wanted === 'auto' || explicit.toLowerCase().startsWith(wanted === 'ki' ? 'ki' : wanted))) return explicit;
  const list = STT_LOCALES[wanted] || [];
  return wanted === 'auto' ? null : (list[0] || null);
}

function languageInfo() {
  const m = mode();
  return {
    mode: m,
    modes: MODES,
    languages: LANGUAGES,
    sttLocale: sttLocale(m),
    sttSupported: m === 'auto' ? true : (STT_LOCALES[m] || []).length > 0,
    stt: {
      en: STT_LOCALES.en, sw: STT_LOCALES.sw, ki: STT_LOCALES.ki,
      kikuyu: false,
      note: 'Web Speech API has no Kikuyu model in any browser; type Kikuyu instead, or add custom phrases to the dictionary.'
    },
    ttsLocales: TTS_PREFERENCE[m].slice(),
    kikuyuTts: 'a device voice may not exist — ARIA falls back to Swahili or Kenyan English, or stays silent without an error',
    fallback: 'Kikuyu replies fall back to Swahili, then English'
  };
}

/** Prompt grounding: matched phrases for this message + the active non-English dictionary. */
function promptBlock(text) {
  const m = mode();
  const applied = text ? apply(text) : { matches: [] };
  const parts = [];
  parts.push(
    `LANGUAGE: the owner's language setting is "${m}". Reply in the language the user wrote in, and mirror Kenyan code-switching (English + Swahili + Sheng mixed in one message) instead of forcing one language. If the setting is Swahili, answer in Swahili unless the user clearly switched. If it is Kikuyu, keep Kikuyu to short, well-known phrases and fall back to Swahili or English when unsure — never invent Kikuyu grammar or translations.`
  );
  if (applied.matches.length) {
    parts.push('PHRASES DETECTED IN THIS MESSAGE:\n' + applied.matches.map((x) => `- "${x.phrase}" (${x.lang}) = ${x.note || x.intent}`).join('\n'));
  }
  const vocab = list({ enabledOnly: true })
    .filter((e) => e.lang !== 'en')
    .slice(0, 40)
    .map((e) => `- "${e.phrase}" (${e.lang}) = ${e.note || e.intent}`);
  if (vocab.length) parts.push('KNOWN PHRASE DICTIONARY (treat as ground truth for meaning):\n' + vocab.join('\n'));
  parts.push('If the user says something in Swahili, Sheng or Kikuyu that you did not understand, ask (in their language, or in Swahili) instead of guessing.');
  return parts.join('\n\n');
}

function stats() {
  const all = list();
  const byLang = {};
  for (const e of all) byLang[e.lang] = (byLang[e.lang] || 0) + 1;
  return {
    count: all.length,
    enabled: all.filter((e) => e.enabled).length,
    byLang,
    mode: mode(),
    languages: LANGUAGES,
    seed: all.filter((e) => e.source === 'seed').length,
    custom: all.filter((e) => e.source !== 'seed').length,
    stt: languageInfo()
  };
}

function _reset() { cache = null; }

module.exports = {
  LANGUAGES, MODES, STT_LOCALES, TTS_PREFERENCE, SEED, SCRIPTS,
  list, add, update, remove, reset, match, matchAll, apply, normalizeTimeWords, scriptedReply,
  mode, replyLang, sttLocale, languageInfo, promptBlock, stats, _reset,
  DOC_ID
};
