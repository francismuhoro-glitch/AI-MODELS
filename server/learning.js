'use strict';
/* DURABLE LEARNING — ARIA learns lasting facts, preferences and corrections from conversation.
   ═══════════════════════════════════════════════════════════════════════════════════════
   HARD RULES THIS MODULE OBEYS
     1. NO SYNCHRONOUS TURN LATENCY. Nothing here is awaited by a reply: callers queue the turn
        (scheduleExtraction) and the work happens on the next tick / hourly sweep. The queue is
        persisted in db.meta.learningQueue first, so a process that dies mid-extraction leaves
        work for the next turn or the scheduler instead of losing it.
     2. CONFLICT RESOLUTION, NOT CONTRADICTION. A correction (or a negated preference) never
        creates a second, contradictory row: it supersedes in place (same id, new content,
        prior text kept in metadata.priorContent).
     3. STRICT NOISE FILTER. Only clear signals are extracted, and every candidate must clear
        MIN_IMPORTANCE — greetings, thanks, questions, commands and filler are dropped.
     4. HARD SECRET/PII SCRUBBING BEFORE PERSISTENCE. PINs, passwords, API keys, tokens, card
        numbers (Luhn-checked), CVV/OTP and private keys are REJECTED outright; anything else
        is passed through secrets.redactText() as a second net.
     5. TRAINING-FREE. Learning is retrieval + preference memory. No model is ever retrained.
   Two extraction paths (both end in the same filter → dedupe → conflict pipeline):
     • high-signal turns  — pure regex/heuristics, zero cost, runs out-of-band on every turn
     • rolling cadence    — every 12 turns (SUMMARY_EVERY) the conversation window is offered
                            to the model for JSON extraction; heuristics are the offline path
*/
const dbm = require('./db');
const cfgm = require('./config');
const memory = require('./memory');
const secrets = require('./secrets');
const permissions = require('./permissions');
const { uid, snippet, tokenize } = require('./util');

/* ─────────────────────────── policy knobs ─────────────────────────── */
const MIN_IMPORTANCE = 0.55;      // strict bar: filler never clears this
const MERGE_JACCARD = 0.86;       // same statement said differently → merge into the one row
const MERGE_SIM = 0.93;           // embedding-only near-identity → merge
const SUPERSEDE_SIM = 0.72;       // same subject, different claim → supersede in place
const CORRECTION_SIM = 0.52;      // explicit corrections may be looser
const POLARITY_SIM = 0.40;        // "I like X" vs "I hate X" — opposite polarity, same anchor
const MAX_CONTENT = 400;
const MAX_CANDIDATES = 6;
const QUEUE_CAP = 50;
const LOG_CAP = 60;

const KINDS = new Set(['fact', 'preference', 'correction']);

/* ════════════════════════════════════════════════════════════════════════
   1. HARD SECRET / PII SCRUBBING (runs BEFORE anything is written)
   ════════════════════════════════════════════════════════════════════════ */

/** Luhn check — distinguishes a real card number from an epoch-millis timestamp. */
function luhn(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function looksLikeCard(text) {
  const runs = String(text || '').match(/\b(?:\d[ -]?){12,19}\b/g) || [];
  return runs.some((r) => luhn(r));
}

/* Each rule is a REJECT reason — a redacted fragment of a PIN or key is still a leak. */
const HARD_SECRET_RULES = [
  { id: 'pin', re: /\b(?:pin|p\.?i\.?n\.?|passcode)\b\s*(?:number\s*)?(?:is|:|=)?\s*\d{4,8}\b/i },
  { id: 'mpesa-pin', re: /\b(?:m-?pesa|mpesa|atm|sim)\b[^.]{0,30}\b(?:pin|password)\b/i },
  { id: 'otp', re: /\b(?:otp|one[-\s]?time\s+(?:code|password)|verification\s+code|2fa\s+code)\b\s*(?:is|:|=)?\s*\d{4,8}\b/i },
  { id: 'password', re: /\b(?:password|passwd|pwd)\b\s*(?:is|:|=)\s*\S{3,}/i },
  { id: 'api-key', re: /\b(?:api[\s_-]?key|apikey|secret[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|auth[\s_-]?token|bearer)\b\s*(?:is|:|=)?\s*[A-Za-z0-9._\-+/=]{8,}/i },
  { id: 'key-shape', re: /\b(?:sk|pk|rk|ghp|gho|ghu|glpat|xox[pboa]|npm|AIza)[-_][A-Za-z0-9_-]{8,}\b/ },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'seed-phrase', re: /\b(?:seed\s+phrase|mnemonic|recovery\s+phrase|wallet\s+phrase)\b/i },
  { id: 'cvv', re: /\bcvv\s*(?:is|:|=)?\s*\d{3,4}\b/i },
  { id: 'card', test: (t) => looksLikeCard(t) }
];

/** Does this text contain something that must NEVER be stored? */
function containsHardSecret(text) {
  const t = String(text || '');
  for (const rule of HARD_SECRET_RULES) {
    const hit = rule.test ? rule.test(t) : rule.re.test(t);
    if (hit) return { hit: true, rule: rule.id };
  }
  return { hit: false, rule: null };
}

/**
 * Sanitise one candidate. Returns { ok:false, reason } when it must not be stored at all,
 * otherwise { ok:true, content } with the secrets-redacted, whitespace-normalised text.
 */
function scrubCandidate(candidate) {
  const raw = String((candidate && candidate.content) || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const hard = containsHardSecret(raw);
  if (hard.hit) return { ok: false, reason: `secret:${hard.rule}` };
  const content = secrets.redactText(raw.replace(/\s+/g, ' ')).trim().slice(0, MAX_CONTENT);
  if (!content) return { ok: false, reason: 'empty-after-redaction' };
  /* Belt and braces: a redaction that still leaves a credential-shaped token is dropped. */
  if (containsHardSecret(content).hit) return { ok: false, reason: 'secret-after-redaction' };
  return { ok: true, content };
}

/* ════════════════════════════════════════════════════════════════════════
   2. NOISE FILTERING + IMPORTANCE
   ════════════════════════════════════════════════════════════════════════ */
const FILLER_RE = /^(?:ok(?:ay)?|k|cool|nice|great|thanks|thank you|ta|cheers|hi|hey|hello|good morning|good afternoon|good evening|yes|yeah|yep|no|nope|sure|fine|hmm+|ah+|oh+|lol|haha|👍|🙏|please|sorry|bye|goodbye|night|good night)\b[\s!.,]*$/i;
const QUESTION_RE = /^(?:what|who|when|where|why|how|which|whose|is|are|do|does|did|can|could|would|should|will|shall|may)\b/i;
const COMMAND_RE = /^(?:set|create|add|schedule|book|send|draft|play|pause|stop|cancel|delete|remove|open|start|plan|move|remind|show|list|tell me|give me|summari[sz]e|find|search)\b/i;

/** Pure: is this text conversational filler / a question / a command rather than a fact? */
function isFiller(content) {
  const t = String(content || '').trim();
  if (!t) return true;
  if (t.length < 8) return true;
  if (FILLER_RE.test(t)) return true;
  /* A question is not a durable fact — unless the owner states one inside it. */
  if (QUESTION_RE.test(t) && !/\b(?:i|my|we|our)\b.{0,40}\b(?:prefer|always|never|like|hate|want|need|am|is)\b/i.test(t)) return true;
  /* An imperative is an action ARIA already ran, not memory. */
  if (COMMAND_RE.test(t) && !/\b(?:i|my|we|our)\b/i.test(t)) return true;
  if (!tokenize(t).length) return true;
  if (/^\W+$/.test(t)) return true;
  return false;
}

/** Deterministic importance. Strict by design: only clear signals clear MIN_IMPORTANCE. */
function importanceOf(content, kind = 'fact', extra = 0) {
  const t = String(content || '');
  let s = 0.42;
  if (kind === 'correction') s += 0.30;
  if (kind === 'preference') s += 0.20;
  if (/\b(?:i|my|me|we|our|us)\b/i.test(t)) s += 0.06;
  if (/\b(?:prefer|always|never|hate|love|like|dislike|want|need|don'?t|usually|from now on|going forward|please)\b/i.test(t)) s += 0.12;
  if (/\b(?:name|company|business|office|boss|wife|husband|partner|son|daughter|birthday|timezone|accountant|lawyer|doctor|car|shop|supplier|client|allerg|medical|account|invoice)\b/i.test(t)) s += 0.08;
  if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) s += 0.05;
  if (t.split(/\s+/).length >= 5) s += 0.05;
  s += Number(extra) || 0;
  return Math.max(0, Math.min(1, Math.round(s * 1000) / 1000));
}

/* ════════════════════════════════════════════════════════════════════════
   3. DUPLICATE / CONFLICT MATHS (pure — unit tested)
   ════════════════════════════════════════════════════════════════════════ */
function bigrams(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Bigram Jaccard similarity — cheap, language-agnostic near-duplicate detection. */
function jaccard(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Stable fingerprint for exact-duplicate prevention (sorted unique content tokens). */
function fingerprint(content) {
  const toks = [...new Set(tokenize(content))].sort();
  return toks.slice(0, 24).join('-').slice(0, 200) || null;
}

/** Do two statements share a meaningful anchor word (not a number/date)? */
function sharesAnchor(a, b) {
  const B = new Set(tokenize(b));
  for (const t of tokenize(a)) if (B.has(t) && t.length > 3 && !/^\d+$/.test(t)) return true;
  return false;
}

/* Verbs and fillers are NOT topic anchors: "I like X" / "I hate Y" share only a verb. */
const NON_ANCHOR = new Set([
  'prefer', 'prefers', 'like', 'likes', 'love', 'loves', 'hate', 'hates', 'dislike', 'dislikes',
  'want', 'wants', 'need', 'needs', 'meant', 'mean', 'said', 'say', 'says', 'think', 'thought',
  'always', 'never', 'usually', 'really', 'actually', 'please', 'thanks', 'thing', 'things',
  'from', 'with', 'that', 'this', 'have', 'having', 'been', 'being'
]);

/** Content words that can identify WHAT a statement is about. */
function anchorTokens(text) {
  return tokenize(text).filter((t) => !NON_ANCHOR.has(t) && !/^\d+$/.test(t));
}

/** How many topic anchors do two statements share? (2+ usually means "same subject".) */
function anchorCount(a, b) {
  const B = new Set(anchorTokens(b));
  let n = 0;
  for (const t of new Set(anchorTokens(a))) if (B.has(t)) n++;
  return n;
}

/* "my X is Y" / "our X is Y" → X is the subject noun. Two different subjects (accountant vs
   lawyer) must NEVER supersede each other just because the value (a name) is the same. */
const SUBJECT_RE = /\b(?:my|our|the|i|we)\s+(?:favourite|favorite|main|current|new|old|usual|regular|preferred)?\s*([a-z][a-z'-]{2,})/gi;

function subjectWords(text) {
  const out = new Set();
  const s = String(text || '');
  let m;
  SUBJECT_RE.lastIndex = 0;
  while ((m = SUBJECT_RE.exec(s)) !== null) {
    const w = m[1].toLowerCase();
    /* "I prefer X" / "I hate Y" capture the VERB, not a subject — polarity owns those. */
    if (!NON_ANCHOR.has(w)) out.add(w);
  }
  return out;
}

/** Both statements are "my X …" but about different X → related, not conflicting. */
function conflictingSubjects(a, b) {
  const A = subjectWords(a), B = subjectWords(b);
  if (!A.size || !B.size) return false;                  // can't tell → don't judge
  for (const w of A) if (B.has(w)) return false;         // shared subject → allowed to conflict
  return true;
}

const POSITIVE = /\b(?:prefer|like|love|enjoy|want|always|usually|favourite|favorite|yes)\b/i;
const NEGATIVE = /\b(?:hate|dislike|never|don'?t|do not|avoid|stop|no longer|instead of)\b/i;

/** Same subject but opposite polarity → a conflict even when the wording barely overlaps. */
function polarityConflict(a, b) {
  const A = String(a || ''), B = String(b || '');
  if (!A || !B) return false;
  const opposite = (POSITIVE.test(A) && NEGATIVE.test(B)) || (NEGATIVE.test(A) && POSITIVE.test(B));
  return opposite && sharesAnchor(A, B);
}

/**
 * PURE conflict decision — the heart of "supersede, never contradict".
 * @returns {{conflict:boolean, reason:string, evidence:{surface:number, anchors:number, semantic:number}}}
 */
function conflictDecision(existingContent, newContent, { kind = 'fact', semantic = 0 } = {}) {
  const surface = jaccard(existingContent, newContent);
  const anchors = anchorCount(existingContent, newContent);
  const evidence = { surface: Math.round(surface * 1000) / 1000, anchors, semantic: Math.round((Number(semantic) || 0) * 1000) / 1000 };
  if (conflictingSubjects(existingContent, newContent)) return { conflict: false, reason: 'different-subject', evidence };
  if (anchors >= 2 && (surface >= 0.25 || semantic >= 0.5)) return { conflict: true, reason: 'same-subject-update', evidence };
  /* One shared TOPIC anchor (not merely a shared verb) plus strong surface overlap. */
  if (anchors >= 1 && surface >= 0.3) return { conflict: true, reason: 'same-subject-update', evidence };
  if (kind === 'correction' && anchors >= 1 && (surface >= 0.2 || semantic >= CORRECTION_SIM)) {
    return { conflict: true, reason: 'correction', evidence };
  }
  if (polarityConflict(existingContent, newContent) && anchors >= 1 && surface >= 0.15) {
    return { conflict: true, reason: 'polarity', evidence };
  }
  return { conflict: false, reason: 'distinct', evidence };
}

/* ════════════════════════════════════════════════════════════════════════
   4. EXTRACTION — heuristics (always) + model (rolling cadence)
   ════════════════════════════════════════════════════════════════════════ */
/* High-signal patterns. `kind` + `importance` are the honest defaults for each signal. */
const EXTRACTORS = [
  { id: 'correction', kind: 'correction', importance: 0.9, re: /\b(?:no,?\s*(?:i\s+)?meant|i\s+meant|that'?s\s+wrong|not\s+what\s+i\s+(?:meant|said)|actually,?\s*(?:it'?s|it is|my|i))\b/i },
  { id: 'correction-2', kind: 'correction', importance: 0.88, re: /\b(?:correct(?:ion)?|to\s+correct|i\s+said\s+wrong)\b/i },
  { id: 'remember', kind: 'fact', importance: 0.9, re: /\b(?:remember|note|keep in mind|don'?t forget)\b/i },
  { id: 'identity', kind: 'fact', importance: 0.85, re: /\b(?:my|our)\s+(?:name|company|business|shop|office|team|boss|wife|husband|partner|son|daughter|child|birthday|timezone|address|accountant|lawyer|doctor|car|house|home|farm)s?\b[^.]{0,60}\b(?:is|are|'s)\b/i },
  { id: 'call-me', kind: 'fact', importance: 0.85, re: /\b(?:call me|my name'?s|i'?m called)\b/i },
  { id: 'preference', kind: 'preference', importance: 0.8, re: /\b(?:i|we)\s+(?:really\s+|always\s+|usually\s+|never\s+|strongly\s+)?(?:prefer|like|love|hate|dislike|want|need)\b/i },
  { id: 'preference-neg', kind: 'preference', importance: 0.82, re: /\b(?:don'?t|do not|never)\s+(?:ever\s+)?(?:call|schedule|book|add|put|send|use|wake)\b/i },
  { id: 'routine', kind: 'preference', importance: 0.75, re: /\b(?:from now on|going forward|in future|next time|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|week|month))\b/i },
  { id: 'life', kind: 'fact', importance: 0.72, re: /\bi\s+(?:work|live|run|own|manage|am\s+based|operate)\b/i },
  { id: 'contact', kind: 'fact', importance: 0.72, re: /\b(?:my|our)\s+(?:supplier|client|customer|landlord|tenant|bank|insurer|dealer|distributor|fundi|driver|assistant)s?\s+(?:is|are)\b/i }
];

/** Which sentence of the message carries the signal? Keep it, clean it, drop the rest. */
function sentenceFor(message, re) {
  const sentences = String(message || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = sentences.find((s) => re.test(s)) || sentences[0] || String(message || '');
  return hit
    .replace(/^(?:hey|hi|hello|ok(?:ay)?|so|well|alright|right)[\s,!.-]+(?:aria[\s,!.-]+)?/i, '')
    .replace(/^aria[\s,!.-]+/i, '')
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTENT);
}

/**
 * Pure heuristic extraction. Returns candidates { content, kind, importance, reason }.
 * Empty array = nothing durable in this turn (the common, correct answer).
 */
function extractHeuristic(message, opts = {}) {
  const msg = String(message || '').trim();
  if (!msg || msg.length < 6) return [];
  const out = [];
  for (const ex of EXTRACTORS) {
    if (!ex.re.test(msg)) continue;
    const content = sentenceFor(msg, ex.re);
    if (!content || isFiller(content)) continue;
    out.push({ content, kind: ex.kind, importance: ex.importance, reason: ex.id });
  }
  /* De-duplicate within the turn (one message often trips two patterns). */
  const uniq = [];
  for (const c of out) {
    if (uniq.some((u) => jaccard(u.content, c.content) >= MERGE_JACCARD)) continue;
    uniq.push(c);
  }
  /* A correction replaces a plain reading of the same sentence. */
  if (uniq.some((u) => u.kind === 'correction')) return uniq.filter((u) => u.kind === 'correction' || u.reason === 'remember').slice(0, MAX_CANDIDATES);
  return uniq.slice(0, MAX_CANDIDATES);
}

/** Does this message carry a durable signal at all? (cheap gate before queueing) */
function hasSignal(message) {
  return extractHeuristic(message).length > 0;
}

const EXTRACT_PROMPT = `You extract DURABLE memory from a conversation between an owner and their assistant.
Return ONLY a JSON array (no prose, no markdown fence). Each item:
{"content":"<one short sentence, first person as the owner said it>","kind":"fact|preference|correction","importance":<0.0-1.0>}
Rules:
- Only lasting facts about the owner, their people, business, tools, routines, preferences and corrections.
- NEVER include passwords, PINs, API keys, tokens, card numbers, OTPs or full message bodies — omit those items entirely.
- No greetings, no questions, no one-off tasks, no calendar entries, no summaries of what ARIA did.
- importance >= 0.6 only for things that stay true for weeks; otherwise omit the item.
- Maximum 5 items. If there is nothing durable, return [].`;

/** Parse the model's JSON array (tolerates fences and chatty prose). */
function parseCandidatesJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  candidates.push(raw);
  const first = raw.indexOf('['), last = raw.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.replace(/[\u201c\u201d]/g, '"').replace(/,\s*([\]}])/g, '$1'));
      if (!Array.isArray(parsed)) continue;
      return parsed
        .filter((x) => x && typeof x === 'object' && typeof x.content === 'string')
        .map((x) => ({
          content: String(x.content),
          kind: KINDS.has(String(x.kind || '').toLowerCase()) ? String(x.kind).toLowerCase() : 'fact',
          importance: Number(x.importance),
          reason: 'model'
        }))
        .slice(0, MAX_CANDIDATES);
    } catch (_) { /* try the next candidate shape */ }
  }
  return [];
}

/**
 * Model extraction over a conversation window (rolling cadence). Falls back to heuristics when
 * no model is reachable — learning never depends on an LLM.
 */
async function extractFromWindow({ turns = [], windowText = '', useModel = true } = {}) {
  const userTurns = (Array.isArray(turns) ? turns : []).filter((t) => t && t.role === 'user').map((t) => String(t.content || ''));
  const transcript = String(windowText || '').trim() || turns
    .map((t) => `${t && t.role === 'assistant' ? 'ARIA' : 'Owner'}: ${snippet(String((t && t.content) || ''), 300)}`)
    .join('\n');
  if (useModel && transcript) {
    try {
      const { llmChat } = require('./llm');
      const out = await llmChat(EXTRACT_PROMPT, `CONVERSATION:\n${transcript}`, []);
      const parsed = parseCandidatesJson(out && out.text);
      if (parsed.length) return parsed;
    } catch (_) { /* offline / bad model output → heuristics */ }
  }
  const out = [];
  for (const turn of userTurns) for (const c of extractHeuristic(turn)) out.push(c);
  return out.slice(0, MAX_CANDIDATES);
}

/* ════════════════════════════════════════════════════════════════════════
   5. DEDUPE + CONFLICT RESOLUTION + PERSISTENCE
   ════════════════════════════════════════════════════════════════════════ */
function learningMeta() {
  const db = dbm.load();
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  if (!db.meta.learning || typeof db.meta.learning !== 'object') {
    db.meta.learning = { saved: 0, merged: 0, superseded: 0, skipped: 0, rejected: 0, lastRunAt: null, lastReasons: [] };
  }
  return db.meta.learning;
}

function logEvent(entry) {
  const m = learningMeta();
  if (!Array.isArray(m.log)) m.log = [];
  m.log.unshift({ at: Date.now(), ...entry });
  if (m.log.length > LOG_CAP) m.log.length = LOG_CAP;
}

/**
 * Store ONE candidate, resolving duplicates and conflicts against existing memory.
 * Returns { action: 'saved'|'merged'|'superseded'|'skipped'|'rejected', memory?, reason }.
 */
async function storeCandidate(candidate, ctx = {}) {
  const scrubbed = scrubCandidate(candidate);
  if (!scrubbed.ok) {
    logEvent({ action: 'rejected', reason: scrubbed.reason, sample: snippet(candidate && candidate.content, 40) });
    return { action: 'rejected', reason: scrubbed.reason };
  }
  const kind = KINDS.has(String(candidate.kind || '').toLowerCase()) ? String(candidate.kind).toLowerCase() : 'fact';
  const importance = Number.isFinite(Number(candidate.importance)) && Number(candidate.importance) > 0
    ? Math.max(0, Math.min(1, Number(candidate.importance)))
    : importanceOf(scrubbed.content, kind);
  if (isFiller(scrubbed.content)) return { action: 'skipped', reason: 'filler' };
  if (importance < MIN_IMPORTANCE) {
    logEvent({ action: 'skipped', reason: `below-threshold:${importance}`, sample: snippet(scrubbed.content, 60) });
    return { action: 'skipped', reason: `below-threshold:${importance}` };
  }

  const content = scrubbed.content;
  const fp = fingerprint(content);
  const existing = await memory.searchMemories(content, 6, { touch: false }).catch(() => []);

  /* 1 ▸ Duplicate → merge into the row we already have (no second row). */
  const dup = existing.find((m) => m.dedupeKey && fp && m.dedupeKey === fp)
    || existing.find((m) => jaccard(m.content, content) >= MERGE_JACCARD)
    || existing.find((m) => (Number(m.semantic) || 0) >= MERGE_SIM);
  if (dup) {
    const keepLonger = String(content).length > String(dup.content || '').length;
    const merged = await memory.updateMemory(dup.id, {
      content: keepLonger ? content : dup.content,
      kind: dup.kind,
      importance: Math.max(Number(dup.importance) || 0, importance),
      dedupeKey: dup.dedupeKey || fp,
      metadataMerge: {
        mergeCount: (Number(dup.metadata && dup.metadata.mergeCount) || 0) + 1,
        lastMergedAt: new Date().toISOString(),
        lastSource: ctx.source || 'chat'
      }
    });
    learningMeta().merged++;
    logEvent({ action: 'merged', id: dup.id, sample: snippet(content, 60) });
    return { action: 'merged', memory: merged || dup, reason: 'duplicate' };
  }

  /* 2 ▸ Conflict → supersede IN PLACE so contradictory rows never coexist. */
  let conflict = null;
  let conflictReason = null;
  for (const m of existing) {
    const decision = conflictDecision(m.content, content, { kind, semantic: Number(m.semantic) || 0 });
    if (decision.conflict) { conflict = m; conflictReason = decision.reason; break; }
  }
  if (conflict) {
    const updated = await memory.updateMemory(conflict.id, {
      content,
      kind: kind === 'correction' ? 'correction' : conflict.kind,
      importance: Math.max(Number(conflict.importance) || 0, importance),
      dedupeKey: fp,
      metadataMerge: {
        priorContent: String(conflict.content || '').slice(0, MAX_CONTENT),
        supersededAt: new Date().toISOString(),
        supersededReason: conflictReason || (kind === 'correction' ? 'correction' : 'conflict'),
        lastSource: ctx.source || 'chat'
      }
    });
    learningMeta().superseded++;
    logEvent({ action: 'superseded', id: conflict.id, prior: snippet(conflict.content, 50), next: snippet(content, 50) });
    permissions.audit({
      integration: 'memory', action: 'supersede', status: 'ok',
      summary: `superseded memory ${conflict.id}`, target: conflict.id
    });
    return { action: 'superseded', memory: updated || { ...conflict, content }, reason: conflictReason || 'conflict' };
  }

  /* 3 ▸ New memory. */
  const saved = await memory.upsertMemory({
    content,
    kind,
    importance,
    source: ctx.source || 'chat',
    dedupeKey: fp,
    metadata: {
      extractedBy: candidate.reason === 'model' ? 'model' : 'heuristic',
      reason: candidate.reason || null,
      chatId: ctx.chatId || null,
      provenance: ctx.provenance || 'conversation'
    }
  });
  if (!saved) return { action: 'skipped', reason: 'store-unavailable' };
  learningMeta().saved++;
  logEvent({ action: 'saved', id: saved.id, kind, sample: snippet(content, 60) });
  return { action: 'saved', memory: saved };
}

/** Run the whole pipeline over a candidate list. Awaitable; never throws. */
async function learn(candidates, ctx = {}) {
  const report = { saved: [], merged: [], superseded: [], skipped: 0, rejected: 0 };
  for (const candidate of (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES)) {
    try {
      const r = await storeCandidate(candidate, ctx);
      if (r.action === 'saved' && r.memory) report.saved.push(r.memory);
      else if (r.action === 'merged' && r.memory) report.merged.push(r.memory);
      else if (r.action === 'superseded' && r.memory) report.superseded.push(r.memory);
      else if (r.action === 'rejected') report.rejected++;
      else report.skipped++;
    } catch (e) {
      report.skipped++;
      logEvent({ action: 'error', reason: secrets.safeError(e) });
    }
  }
  const m = learningMeta();
  m.lastRunAt = Date.now();
  m.lastReasons = [...report.saved, ...report.merged, ...report.superseded].map((x) => snippet(x.content, 60)).slice(0, 5);
  try { await dbm.saveNow(); } catch (_) {}
  return report;
}

/** One turn: heuristic extraction + persistence. Awaitable (the queue processor awaits this). */
async function extractFromTurn({ message, reply, source = 'chat', chatId = null, useModel = false } = {}) {
  const candidates = extractHeuristic(message, { reply });
  if (!candidates.length) return { saved: [], merged: [], superseded: [], skipped: 0, rejected: 0 };
  return await learn(candidates, { source, chatId, provenance: 'turn' });
}

/* ════════════════════════════════════════════════════════════════════════
   6. NON-BLOCKING QUEUE (persisted first, processed on the next tick)
   ════════════════════════════════════════════════════════════════════════ */
function queue() {
  const db = dbm.load();
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  if (!Array.isArray(db.meta.learningQueue)) db.meta.learningQueue = [];
  return db.meta.learningQueue;
}

/**
 * Queue a turn for out-of-band extraction. NEVER awaited by a reply, and the entry is
 * persisted before returning — if the process dies, the scheduler's sweep finishes the job.
 */
function scheduleExtraction({ message, reply, source = 'chat', chatId = null } = {}) {
  try {
    if (!hasSignal(message)) return { queued: false, reason: 'no-signal' };
    const q = queue();
    q.unshift({ id: uid('lq'), kind: 'turn', message: String(message || '').slice(0, 2000), reply: String(reply || '').slice(0, 500), source, chatId, ts: Date.now() });
    if (q.length > QUEUE_CAP) q.length = QUEUE_CAP;
    try { dbm.save(); } catch (_) {}
    setImmediate(() => { processQueue().catch(() => {}); });
    return { queued: true, pending: q.length };
  } catch (_) {
    return { queued: false, reason: 'error' };
  }
}

/** Queue the rolling-cadence extraction (every SUMMARY_EVERY turns) — model-assisted. */
function scheduleSummaryExtraction({ turns = [], windowText = '', chatId = null } = {}) {
  try {
    const q = queue();
    q.unshift({ id: uid('lq'), kind: 'summary', turns: (Array.isArray(turns) ? turns : []).slice(-24), windowText: String(windowText || '').slice(0, 4000), chatId, ts: Date.now() });
    if (q.length > QUEUE_CAP) q.length = QUEUE_CAP;
    try { dbm.save(); } catch (_) {}
    setImmediate(() => { processQueue().catch(() => {}); });
    return { queued: true, pending: q.length };
  } catch (_) {
    return { queued: false, reason: 'error' };
  }
}

let running = null;

/**
 * Drain the learning queue. Re-entrant-safe (concurrent callers share one promise), and safe to
 * call from the hourly scheduler sweep. Returns a summary of what was learned.
 */
async function processQueue() {
  if (running) return running;
  running = (async () => {
    const report = { processed: 0, saved: 0, merged: 0, superseded: 0, skipped: 0, rejected: 0 };
    try {
      let guard = 0;
      while (queue().length && guard++ < 20) {
        const item = queue().shift();
        if (!item) break;
        try {
          const candidates = item.kind === 'summary'
            ? await extractFromWindow({ turns: item.turns || [], windowText: item.windowText, useModel: true })
            : extractHeuristic(item.message);
          const r = await learn(candidates, { source: item.kind === 'summary' ? 'summary' : (item.source || 'chat'), chatId: item.chatId, provenance: item.kind === 'summary' ? 'rolling-summary' : 'turn' });
          report.processed++;
          report.saved += r.saved.length;
          report.merged += r.merged.length;
          report.superseded += r.superseded.length;
          report.skipped += r.skipped;
          report.rejected += r.rejected;
        } catch (e) {
          logEvent({ action: 'error', reason: secrets.safeError(e) });
        }
        try { await dbm.saveNow(); } catch (_) {}
      }
    } finally {
      running = null;
    }
    return report;
  })();
  return running;
}

/** Awaitable drain — used by tests and the scheduler. */
const flush = () => processQueue();

/* ════════════════════════════════════════════════════════════════════════
   7. "FORGET THAT" (spoken / typed)
   ════════════════════════════════════════════════════════════════════════ */
/**
 * Match a forget command. Returns { mode: 'last' | 'topic' | 'everything', query } or null.
 * Deliberately narrow so it can never hijack a calendar/task command.
 */
function matchForget(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^(?:forget|delete|remove|drop|clear)\s+(?:everything|all|my\s+memories|all\s+my\s+memories)\b(?:\s+(?:you\s+know|about\s+me|please))?[.!?]*$/i.test(s)) return { mode: 'everything', query: '' };
  if (/^(?:forget|delete|remove|drop)\s+(?:that|it|this)(?:\s+(?:memory|fact|preference))?(?:\s+please)?[.!?]*$/i.test(s)) return { mode: 'last', query: '' };
  let m = s.match(/^forget\s+(?:what|everything|anything)\s+(?:i|you)\s+(?:told|said|know|remember(?:ed)?|learned)\b(?:\s+about\s+(.+?))?[.!?]*$/i);
  if (m) return m[1] && m[1].trim() ? { mode: 'topic', query: m[1].trim() } : { mode: 'last', query: '' };
  m = s.match(/^(?:stop\s+remembering|don'?t\s+remember|unlearn)\s+(.+?)[.!?]*$/i);
  if (m) return { mode: 'topic', query: m[1].trim() };
  m = s.match(/^(?:forget|delete|remove)\s+(?:the\s+|my\s+|any\s+)?(?:memory|memories|memory\s+about|what\s+you\s+know)\s*(?:about\s+|of\s+|on\s+|:)?\s*(.+?)[.!?]*$/i);
  if (m && m[1] && m[1].trim()) return { mode: 'topic', query: m[1].trim() };
  return null;
}

/** The newest memory ARIA learned automatically (what a bare "forget that" refers to). */
async function latestLearned() {
  const list = await memory.listMemories({ limit: 10 }).catch(() => []);
  return list.find((m) => m && /conversation|rolling-summary/.test(String((m.metadata && m.metadata.provenance) || '')))
    || list[0] || null;
}

/**
 * Execute a forget command. Always reports exactly what was removed (never claims more).
 * @returns {Promise<{mode:string, removed:number, items:Array, reply:string}>}
 */
async function forget({ mode = 'last', query = '', ids } = {}) {
  if (Array.isArray(ids) && ids.length) {
    const r = await memory.removeMany(ids);
    const items = ids.map((id) => ({ id }));
    permissions.audit({ integration: 'memory', action: 'forget', status: 'ok', summary: `forgot ${r.deleted} memory item(s)`, target: ids[0] });
    return { mode: 'ids', removed: r.deleted, items, reply: `🧹 Forgot ${r.deleted} memory item${r.deleted === 1 ? '' : 's'}.` };
  }
  if (mode === 'everything') {
    const all = await memory.listMemories({ limit: 200 }).catch(() => []);
    const r = await memory.forgetAll();
    permissions.audit({ integration: 'memory', action: 'forget-all', status: 'ok', summary: `forgot everything (${r.deleted})` });
    return {
      mode, removed: r.deleted, items: all.map((m) => ({ id: m.id, content: m.content })),
      reply: r.deleted
        ? `🧹 Forgotten — I deleted all ${r.deleted} memor${r.deleted === 1 ? 'y' : 'ies'}. Anything you tell me from now on starts a fresh memory.`
        : 'There was nothing in memory to forget.'
    };
  }
  if (mode === 'last') {
    const last = await latestLearned();
    if (!last) return { mode, removed: 0, items: [], reply: 'I have nothing in long-term memory to forget.' };
    const r = await memory.removeMemory(last.id);
    permissions.audit({ integration: 'memory', action: 'forget', status: 'ok', summary: 'forgot the last learned memory', target: last.id });
    return {
      mode, removed: r.deleted ? 1 : 0, items: [{ id: last.id, content: last.content }],
      reply: r.deleted
        ? `🧹 Forgotten: "${snippet(last.content, 160)}". It is gone from long-term memory (it may still live in the Second Brain if it was captured as a note).`
        : 'I could not delete that memory — nothing was changed.'
    };
  }
  const q = String(query || '').trim();
  if (!q) return { mode: 'topic', removed: 0, items: [], reply: 'Tell me what to forget — for example "forget that about the supplier".' };
  const hits = await memory.searchMemories(q, 5, { touch: false }).catch(() => []);
  /* Only forget what is genuinely about the topic. A topic delete must never take neighbours:
     EVERY content word of the request must appear in the memory (plural-tolerant), and we do
     not fall back to raw embedding similarity — "supplier" scores high against every supplier
     sentence, so similarity alone would over-delete. */
  const qWords = [...new Set(tokenize(q))];
  const hasWord = (hay, t) => hay.includes(t) || (t.endsWith('s') ? hay.includes(t.slice(0, -1)) : hay.includes(t + 's'));
  const strong = (qWords.length ? hits.filter((h) => qWords.every((t) => hasWord(String(h.content || '').toLowerCase(), t))) : []).slice(0, 5);
  if (!strong.length) {
    return { mode: 'topic', removed: 0, items: [], reply: `Nothing in memory matches "${snippet(q, 80)}" — I did not delete anything.` };
  }
  const r = await memory.removeMany(strong.map((h) => h.id));
  permissions.audit({ integration: 'memory', action: 'forget', status: 'ok', summary: `forgot ${r.deleted} memory item(s) about "${snippet(q, 60)}"` });
  return {
    mode: 'topic', removed: r.deleted, items: strong.map((h) => ({ id: h.id, content: h.content })),
    reply: `🧹 Forgotten ${r.deleted} memor${r.deleted === 1 ? 'y' : 'ies'} about "${snippet(q, 80)}":\n` +
      strong.map((h) => `- ${snippet(h.content, 140)}`).join('\n')
  };
}

/** Read them back — "what do you remember about X?". */
async function recallReply(query) {
  const q = String(query || '').trim();
  const list = q ? await memory.searchMemories(q, 6, { touch: false }).catch(() => []) : await memory.listMemories({ limit: 8 }).catch(() => []);
  if (!list.length) {
    return q
      ? `I have nothing in long-term memory about "${snippet(q, 80)}" yet. Tell me and I will remember it.`
      : 'My long-term memory is empty so far. Anything memorable you tell me gets stored automatically.';
  }
  const header = q ? `**What I remember about "${snippet(q, 80)}"**` : '**What I remember** (most recent first)';
  return `${header}:\n` + list.map((m) => `- ${m.kind && m.kind !== 'fact' ? `_${m.kind}_ — ` : ''}${snippet(m.content, 200)}`).join('\n') +
    '\n\nSay "forget that" (or "forget what you know about …") and it is gone.';
}

/* ════════════════════════════════════════════════════════════════════════
   8. STATUS
   ════════════════════════════════════════════════════════════════════════ */
function stats() {
  const m = learningMeta();
  return {
    minImportance: MIN_IMPORTANCE,
    pending: queue().length,
    saved: m.saved || 0,
    merged: m.merged || 0,
    superseded: m.superseded || 0,
    skipped: m.skipped || 0,
    rejected: m.rejected || 0,
    lastRunAt: m.lastRunAt || null,
    recent: Array.isArray(m.log) ? m.log.slice(0, 8) : [],
    policy: {
      mergeJaccard: MERGE_JACCARD, mergeSim: MERGE_SIM,
      supersedeSim: SUPERSEDE_SIM, correctionSim: CORRECTION_SIM,
      scrubbing: HARD_SECRET_RULES.map((r) => r.id)
    },
    models: (() => { try { const { llmStatus } = require('./llm'); return llmStatus().activeEngine || 'offline'; } catch (_) { return 'offline'; } })(),
    /* Honest note: extraction is retrieval + preference memory. No model is ever retrained. */
    training: 'none — learning is retrieval + preference memory'
  };
}

function _reset() {
  const db = dbm.load();
  if (db.meta) {
    db.meta.learningQueue = [];
    if (db.meta.learning) delete db.meta.learning;
  }
  running = null;
}

module.exports = {
  MIN_IMPORTANCE, MERGE_JACCARD, MERGE_SIM, SUPERSEDE_SIM, CORRECTION_SIM, POLARITY_SIM, MAX_CANDIDATES,
  HARD_SECRET_RULES,
  luhn, looksLikeCard, containsHardSecret, scrubCandidate,
  isFiller, importanceOf, bigrams, jaccard, fingerprint, sharesAnchor, anchorTokens, anchorCount,
  subjectWords, conflictingSubjects, polarityConflict, conflictDecision,
  EXTRACTORS, extractHeuristic, hasSignal, parseCandidatesJson, extractFromWindow,
  storeCandidate, learn, extractFromTurn,
  scheduleExtraction, scheduleSummaryExtraction, processQueue, flush, queue,
  matchForget, forget, latestLearned, recallReply, stats, logEvent,
  _reset
};
