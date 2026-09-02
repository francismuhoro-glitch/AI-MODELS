'use strict';
/**
 * ARIA Assistant — deterministic intent routing + actions + web search + LLM fallback.
 *
 * Conversation intelligence (this module):
 *   • Multi-turn memory  — the last 10 turns from db.chats are passed into llmChat() and a
 *     persistent conversation state (db.meta.conversation) tracks the last intent, the last
 *     query template and key entities (people, dates, topics) across turns.
 *   • Follow-up handling — "what is my schedule today?" → "what about tomorrow?" is rewritten
 *     into a full question using the previous turn, and entity carry-over lets
 *     "schedule a meeting with Kamau" → "add another one for Friday" work without a name.
 *   • Autonomous planner — "plan my day tomorrow" / "build a weekly plan" generates a full
 *     calendar (wake brief, focus blocks, meeting slots, triage windows, buffers) around the
 *     user's rhythm and existing events, with iterative refinement ("move the standup to
 *     10am", "remove the inbox triage").
 *   • Speech discretion — every reply ships a TTS-safe `speech` field: secrets redacted
 *     (PINs, tokens, cards, emails, phones), long lists summarised, profanity masked.
 */
const dbm = require('./db');
const brain = require('./brain');
const cfgm = require('./config');
const weblearn = require('./weblearn');
const websearch = require('./websearch');
const { llmChat, llmStatus } = require('./llm');
const { dayKey, timeStr, dayLabel, dayKeyAdd, dayKeyDow, zonedTime, snippet, extractTopics, cleanProfanity } = require('./util');

const SYSTEM_PROMPT = `You are ARIA, the user's private executive assistant inside ARIA OS.
You manage their day job and their business. You are concise, proactive, well-organized.
You remember the earlier turns of this conversation (provided as history) — resolve follow-up
questions like "what about tomorrow?" or "add another one" using that context instead of asking again.
Use the provided CONTEXT (calendar, emails, chats, second-brain notes) to answer the user's query.
If something is unknown, say so and suggest what to check. Never invent meetings or emails.`;

/* ─── Intent classification ───────────────────────────────────────────── */
const WEB_SEARCH_PATTERNS = [
  /^search\s+(?:for\s+)?/i,
  /^look\s+up\s+/i,
  /^find\s+(?:out\s+)?(?:about|who|what|where|when|how|why)\s+/i,
  /^what\s+is\s+(?:the|a\s+)?(?!my|your|our|today|on|the\s+(?:time|date|schedule|calendar))/i,
  /^who\s+is\s+/i,
  /^where\s+is\s+(?!my)/i,
  /^when\s+(?:was|did|is|are)\s+(?!my|our|your)/i,
  /^how\s+(?:does|do|did|can|could|is)\s+/i,
  /^latest\s+(?:news|updates|on|about)\s+/i,
  /^news\s+(?:on|about)\s+/i,
  /^tell\s+me\s+(?:about|who|what)\s+/i,
  /^define\s+/i,
  /^explain\s+/i,
  /(?:on|in)\s+github$/i,
  /what\s+does\s+\S+\s+mean/i,
  /(?:current|recent)\s+(?:news|events|developments)/i,
  /^(?:google|web\s*search)\s+/i,
];

const PERSONAL_OPERATIONAL_PATTERNS = [
  /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|sup|yo)\b/i,
  /^(?:what(?:'s|\s+is)\s+(?:on|up|my|the\s+schedule|the\s+calendar))/i,
  /^(?:schedule|calendar|agenda|my\s+day|today)/i,
  /^(?:priorit|urgent|important|to\s?do|tasks|focus|my\s+tasks)/i,
  /^(?:inbox|email|emails|unread|messages|my\s+messages)/i,
  /^(?:slack|whatsapp|chat)/i,
  /^(?:business|orders|suppliers|money|revenue|sales|my\s+business)/i,
  /^(?:my\s+name|who\s+am\s+i|what.*know\s+about\s+me)/i,
  /^(?:remember|note)\b/i,
  /^(?:add\s+(?:task|event)|create\s+(?:meeting|task|event)|todo|remind\s+me)/i,
  /^(?:complete\s+task|mark\s+done|finish\s+task|done\s+with)/i,
  /^(?:call\s+me|my\s+name\s+is)/i,
  /^(?:what(?:'s|\s+is)\s+my\s+name)/i,
  /* "how is my inbox?" / "how does my calendar look?" are operational, never web searches */
  /^how\s+(?:is|are|does|do)\s+(?:my|our|the)\s+(?:inbox|calendar|schedule|day|business|email|emails)\b/i,
  /^(?:plan|organize|organise|build|create)\b.*\b(?:day|schedule|plan|week)\b/i,
  /^(?:move|remove|delete|drop|cancel)\s+(?:the\s+|my\s+)?\S+/i,
];

function isWebSearchQuery(msg) {
  const m = String(msg || '').trim();
  return WEB_SEARCH_PATTERNS.some(p => p.test(m)) && !isPersonalQuery(m);
}

function isPersonalQuery(msg) {
  const m = String(msg || '').trim();
  return PERSONAL_OPERATIONAL_PATTERNS.some(p => p.test(m));
}

/* ════════════════════════════════════════════════════════════════════════
   1. CONVERSATION MEMORY — history, entity carry-over, follow-up resolution
   ════════════════════════════════════════════════════════════════════════ */
const MEMORY_TURNS = 10;   // window passed to the LLM (6–10 turns per spec)

/* Persistent per-conversation state — survives restarts inside db.meta. */
function convState(db) {
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  if (!db.meta.conversation || typeof db.meta.conversation !== 'object') {
    db.meta.conversation = { entities: {}, lastIntent: null, lastQuery: null, lastSubject: null, lastPerson: null, pendingPlan: null, updatedAt: 0 };
  }
  const c = db.meta.conversation;
  if (!c.entities || typeof c.entities !== 'object') c.entities = {};
  if (!Array.isArray(c.entities.people)) c.entities.people = [];
  if (!Array.isArray(c.entities.topics)) c.entities.topics = [];
  return c;
}

/* The last N chat turns, oldest first — fed to the LLM as message history. */
function recentHistory(db, turns = MEMORY_TURNS) {
  const chats = (db.chats || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return chats.slice(-turns).map(c => ({
    role: c.role === 'assistant' ? 'assistant' : 'user',
    content: String(c.content || '')
  }));
}

function buildMemory(db) {
  const conv = convState(db);
  return { conv, history: recentHistory(db), entities: conv.entities };
}

const DAY_PHRASE_RE = /(today|tonight|tomorrow|yesterday|next week|this week|weekend|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i;

/* Which kind of operational query is this? Used to remember the "topic" of a turn. */
function classifyQuery(msg) {
  const m = String(msg || '').toLowerCase();
  if (/\b(schedule|calendar|agenda|my day|meetings|what('s| is) on|day look|free|busy)\b/.test(m)) return 'schedule-query';
  if (/\b(priorit|urgent|important|to[- ]?do|tasks|focus)\b/.test(m)) return 'priorities-query';
  if (/\b(inbox|email|unread|messages)\b/.test(m)) return 'inbox-query';
  if (/\b(business|revenue|orders|suppliers|sales)\b/.test(m)) return 'business-query';
  return null;
}

/* Rewrite a remembered query so it points at a new day: "…today" → "…tomorrow". */
function swapDayInQuery(query, target) {
  const q = String(query || '');
  if (/\b(today|tonight)\b/i.test(q)) return q.replace(/\b(today|tonight)\b/i, target);
  if (/\btomorrow\b/i.test(q)) return q.replace(/\btomorrow\b/i, target);
  if (/\byesterday\b/i.test(q)) return q.replace(/\byesterday\b/i, target);
  if (/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(q)) return q.replace(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i, target);
  if (/\b(?:next|this)\s+week\b/i.test(q)) return q.replace(/\b(?:next|this)\s+week\b/i, target);
  return `${q} ${target}`;
}

/**
 * Detect a follow-up and rewrite it into a self-contained question using the
 * previous turn. Returns { isFollowUp, message, note }.
 */
function resolveFollowUp(message, memory) {
  const raw = String(message || '').trim();
  const conv = (memory && memory.conv) || {};
  const out = { isFollowUp: false, message: raw, note: null };
  if (!raw) return out;

  let target = null;

  /* "what about tomorrow?" / "how about friday?" / "and next week?" / bare "tomorrow?" */
  let mm = raw.match(/^(?:what|how)\s+about\s+(.+?)\s*[?.!]*$/i) || raw.match(/^and\s+(?:what\s+about\s+|for\s+|on\s+)?(.+?)\s*[?.!]*$/i) || raw.match(/^(?:what\s+)?(today|tonight|tomorrow|yesterday|next week|this week|weekend|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\s*[?.!]*$/i);
  if (mm) target = (mm[1] || '').trim();

  if (target && DAY_PHRASE_RE.test(target) && conv.lastIntent === 'schedule-query' && conv.lastQuery) {
    const rewritten = swapDayInQuery(conv.lastQuery, target);
    out.isFollowUp = true;
    out.message = rewritten;
    out.note = `Follow-up to "${conv.lastQuery}" — resolved to "${rewritten}"`;
    return out;
  }

  /* "add another one for Friday" — entity carry-over from the last scheduled item. */
  mm = raw.match(/^(?:add|schedule|create|book)\s+another\s+(?:one|meeting|event|appointment|session)(?:\s+(?:for|on|at)\s+(.+?))?\s*[?.!]*$/i);
  if (mm && (conv.lastIntent === 'schedule-create' || conv.lastSubject || conv.lastPerson)) {
    const when = (mm[1] || '').trim();
    const person = conv.lastPerson ? ` with ${conv.lastPerson}` : '';
    const rewritten = `schedule a meeting${person}${when ? ' for ' + when : ''}`;
    out.isFollowUp = true;
    out.message = rewritten;
    out.note = `Follow-up scheduling — carried over ${person ? `"${conv.lastPerson}"` : 'the previous subject'} from the earlier request`;
    return out;
  }

  return out;
}

/* Remember the entities + query topic of this turn for the NEXT turn's carry-over. */
function updateMemory(db, rawMessage, effectiveMessage, intent) {
  const conv = convState(db);
  const m = String(rawMessage || '');
  const topics = extractTopics(m, 3);
  conv.entities.topics = [...new Set([...(conv.entities.topics || []), ...topics])].slice(-10);

  const personMatch = m.match(/\b(?:with|for|to|call|meet\s+with)\s+([A-Za-z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?)/);
  if (personMatch) {
    const candidate = personMatch[1].trim();
    if (!/^(me|us|them|him|her|you|the|a|an|my|our|your)$/i.test(candidate) && !DAY_PHRASE_RE.test(candidate)) {
      conv.entities.people = [...new Set([...(conv.entities.people || []), candidate.toLowerCase()])].slice(-10);
      conv.lastPerson = candidate.charAt(0).toUpperCase() + candidate.slice(1);
    }
  }

  const cls = classifyQuery(effectiveMessage);
  if (intent) {
    /* An explicit intent (schedule-create, plan, …) is authoritative — never let the
       generic query classifier mistake "schedule a meeting…" for a schedule question. */
    conv.lastIntent = intent;
    if (intent === 'schedule-create') conv.lastSubject = conv.lastSubject || null;
  } else if (cls) {
    conv.lastIntent = cls;
    conv.lastQuery = String(effectiveMessage || '').trim();
  }
  conv.updatedAt = Date.now();
  return conv;
}

/* ════════════════════════════════════════════════════════════════════════
   2. MAIN ENTRY — respond()
   ════════════════════════════════════════════════════════════════════════ */
async function respond(message) {
  const cfg = cfgm.load();
  const db = dbm.load();
  const engine = llmStatus();
  const raw = String(message || '').trim();

  db.upsert('chats', { id: `chat-${Date.now()}-u`, role: 'user', content: raw, ts: Date.now() });

  /* Conversation memory: recent turns + persistent entity/topic state. */
  const memory = buildMemory(db);

  /* Follow-up resolution — "what about tomorrow?" becomes a full question. */
  const resolved = resolveFollowUp(raw, memory);
  const effective = resolved.message || raw;

  let reply, source, intent = null;
  const pre = await routeIntent(effective, memory);
  if (pre) {
    reply = pre.reply;
    intent = pre.intent || null;
    source = 'intent';
  } else if (isWebSearchQuery(effective)) {
    // Explicit web search query -> directly trigger live web search
    reply = await handleWebSearch(effective);
    source = 'web-search';
  } else {
    const context = brain.contextPack(effective);
    /* Multi-turn memory: pass everything except the current turn (it is the user turn below). */
    const history = memory.history.filter((h, i) => !(i === memory.history.length - 1 && h.role === 'user'));
    const followUpNote = resolved.isFollowUp ? `\n\n(This message is a FOLLOW-UP. ${resolved.note || ''})` : '';
    const { text, engine: usedEngine } = await llmChat(
      SYSTEM_PROMPT,
      `CONTEXT:\n${context}\n\nCURRENT TIME: ${dayLabel(Date.now(), cfg.owner.timezone)} ${timeStr(Date.now(), cfg.owner.timezone)} (${cfg.owner.timezone})\n\nUSER: ${effective}${followUpNote}`,
      history
    );
    if (text) {
      reply = text;
      source = usedEngine;
    } else {
      reply = await offlineEngine(effective, context, engine);
      source = 'offline-engine';
    }
  }

  updateMemory(db, raw, effective, intent);

  db.upsert('chats', { id: `chat-${Date.now()}-a`, role: 'assistant', content: reply, ts: Date.now(), engine: source });
  await dbm.saveNow();

  /* TTS-safe twin of the reply: secrets redacted, lists summarised, profanity masked.
     The full detail stays in `reply` for the screen. */
  const speech = toSpeechText(reply, { discretion: cfg.discretion !== false });

  return {
    reply,
    speech,
    engine: source,
    llm: engine,
    ...(resolved.isFollowUp ? { followUp: true, resolvedFrom: raw, resolvedTo: effective } : {})
  };
}

/* ─── Web search handler ──────────────────────────────────────────────── */
async function handleWebSearch(message) {
  try {
    const webHits = (await websearch.searchWeb(message, 3)).map(h => ({ ...h, title: cleanProfanity(h.title), snippet: cleanProfanity(h.snippet) }));
    if (webHits && webHits.length > 0) {
      // Ingest top result into Supabase in background
      if (webHits[0].url && webHits[0].url.startsWith('http')) {
        weblearn.learnFromUrl(webHits[0].url).catch(() => {});
      }
      let reply = '🌐 **Live Web Search Results:**\n\n';
      reply += webHits.map((h, i) => '- **' + h.title + '**\n  ' + (h.snippet || 'Read full source online.') + '\n  🔗 [' + h.source + '](' + h.url + ')').join('\n\n');
      reply += '\n\n_Sources: ' + webHits.map(h => h.source).filter(Boolean).join(', ') + '_';
      return reply;
    }
  } catch (_) {}
  return 'I searched the web for "' + message + '" but could not find any results. You can try rephrasing the query.';
}

function parseRelativeDateTime(text) {
  const now = new Date();
  let targetDate = new Date(now.getTime());
  const clean = String(text).toLowerCase();

  if (clean.includes('tomorrow')) targetDate.setDate(now.getDate() + 1);
  else if (clean.includes('tonight')) { /* today */ }
  else if (/next\s+monday/.test(clean)) targetDate.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  else if (/next\s+friday/.test(clean)) targetDate.setDate(now.getDate() + ((5 + 7 - now.getDay()) % 7 || 7));
  else {
    /* Any named weekday: "on friday", "for tuesday" → the next occurrence (strictly future). */
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const wd = clean.match(/\b(?:on|for|this|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (wd) {
      const want = days[wd[1]];
      const delta = (want - now.getDay() + 7) % 7 || 7;
      targetDate.setDate(now.getDate() + delta);
    }
  }

  let hours = 9, minutes = 0;
  const tm = clean.match(/at\s+(\d+)(?::(\d+))?\s*(am|pm)?/);
  if (tm) {
    hours = parseInt(tm[1], 10);
    if (tm[2]) minutes = parseInt(tm[2], 10);
    const ampm = tm[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  } else {
    const bare = clean.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (bare) {
      hours = parseInt(bare[1], 10);
      if (bare[2]) minutes = parseInt(bare[2], 10);
      if (bare[3] === 'pm' && hours < 12) hours += 12;
      if (bare[3] === 'am' && hours === 12) hours = 0;
    }
  }
  targetDate.setHours(hours, minutes, 0, 0);
  return targetDate.getTime();
}

/* ════════════════════════════════════════════════════════════════════════
   3. INTENT ROUTING (incl. autonomous planner + schedule refinement)
   ════════════════════════════════════════════════════════════════════════ */
async function routeIntent(msg, memory) {
  const m = String(msg || '').trim();
  if (!m) return null;
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const conv = convState(db);

  /* ---- Plan confirmation / cancellation (before generic event removal) ---- */
  if (conv.pendingPlan && (/^(?:confirm|lock(?:\s+it)?(?:\s+in)?|approve|keep|sounds\s+good|yes(?:\s+please)?)\b/i.test(m) || /^(?:yes|confirm|lock it in|approve)[.!\s]*$/i.test(m))) {
    return { reply: await confirmPlan(), intent: 'plan-confirm' };
  }
  if (conv.pendingPlan && /^(?:cancel|scrap|discard|delete|throw\s+away)\s+(?:the\s+|my\s+)?plan\b/i.test(m)) {
    return { reply: await cancelPlan(), intent: 'plan-cancel' };
  }

  /* ---- Autonomous multi-step scheduling ---- */
  if (isPlannerRequest(m)) {
    return { reply: await generateSchedule(m), intent: 'plan' };
  }

  /* ---- Schedule refinement: "move the standup to 10am" ---- */
  let mm = m.match(/^move\s+(?:the\s+|my\s+|our\s+)?(.+?)\s+to\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[?.!]*$/i);
  if (mm) {
    const moved = await moveEvent(mm[1], parseInt(mm[2], 10), mm[3] ? parseInt(mm[3], 10) : 0, (mm[4] || '').toLowerCase(), tz);
    if (moved) return { reply: moved, intent: 'schedule-refine' };
  }

  /* ---- Schedule refinement: "remove the inbox triage" / "cancel my 3pm" ---- */
  mm = m.match(/^(?:remove|delete|drop|cancel)\s+(?:the\s+|my\s+|our\s+)?(.+?)(?:\s+(?:from|off)\s+(?:the\s+|my\s+)?(?:plan|schedule|day|calendar))?\s*[?.!]*$/i);
  if (mm && !/^(?:task|todo|reminder)\b/i.test(mm[1])) {
    const removed = await removeEvent(mm[1], tz);
    if (removed) return { reply: removed, intent: 'schedule-refine' };
  }

  /* ---- Schedule Event ---- */
  mm = m.match(/^(?:schedule|add event|create meeting|meeting with|calendar)\s+(.+)$/i);
  if (mm) {
    const raw = mm[1].trim();
    const start = parseRelativeDateTime(raw);
    const cleanTitle = titleCase(
      raw.replace(/(at\s+\d+(:\d+)?\s*(am|pm)?|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|tomorrow|today|tonight|yesterday|next\s+\w+|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|for\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight)\b|this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b)/gi, '')
        .replace(/^(?:a|an|the|another)\s+/i, '')
        .replace(/\b(?:for|on|at|this|next)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
    ) || 'Appointment';
    const newEvent = {
      id: `event-${Date.now()}`,
      title: cleanTitle,
      start,
      end: start + 3600000,
      context: /client|order|supplier|money|biz|pay/i.test(raw) ? 'business' : 'day-job',
      source: 'assistant'
    };
    db.events = db.events || [];
    db.events.push(newEvent);
    conv.lastIntent = 'schedule-create';
    conv.lastSubject = cleanTitle;
    await dbm.saveNow();
    brain.buildIndex();
    return { reply: `📅 **Event Scheduled:** "${newEvent.title}" on ${dayLabel(newEvent.start, tz)} at ${timeStr(newEvent.start, tz)}.`, intent: 'schedule-create' };
  }

  /* ---- Add Task ---- */
  mm = m.match(/^(?:add task|todo|remind me to|prioritize|create task):?\s+(.+)$/i);
  if (mm) {
    const taskTitle = mm[1].trim();
    const isHigh = /urgent|important|asap|critical|now/i.test(taskTitle);
    db.inbox = db.inbox || [];
    db.inbox.unshift({
      id: `task-${Date.now()}`,
      title: taskTitle.replace(/urgent|asap|critical/gi, '').trim(),
      priority: isHigh ? 'high' : 'medium',
      done: false,
      ts: Date.now(),
      context: /client|invoice|sale|biz/i.test(taskTitle) ? 'business' : 'day-job'
    });
    await dbm.saveNow();
    return { reply: `✅ **Task Added:** "${db.inbox[0].title}" (Priority: ${isHigh ? '🔥 High' : '⚡ Normal'})`, intent: 'task-add' };
  }

  /* ---- Complete Task ---- */
  mm = m.match(/^(?:complete task|mark done|finish task|done with)\s+(.+)$/i);
  if (mm) {
    const q = mm[1].toLowerCase().trim();
    const item = (db.inbox || []).find(t => !t.done && (t.title || '').toLowerCase().includes(q));
    if (item) {
      item.done = true;
      await dbm.saveNow();
      return { reply: `🎉 **Completed Task:** "${item.title}"`, intent: 'task-complete' };
    }
  }

  /* ---- Identity Commands ---- */
  mm = m.match(/^my name is\s+(.{2,60}?)\s*$/i);
  if (mm) return { reply: await setName(mm[1].replace(/[.!?]+$/, '').trim()), intent: 'identity' };
  mm = m.match(/^(?:please\s+)?call me\s+([a-z]+(?:[ -][a-z]+){0,2})\s*[.!?]*$/i);
  if (mm && !/^(later|tomorrow|now|soon|back)$/i.test(mm[1].split(/[\s-]+/)[0].trim())) return { reply: await setName(mm[1].trim()), intent: 'identity' };

  if (/^(what(?:'s| is) my name|who am i|do you know (?:my name|who i am)|what do you know about me)\??$/i.test(m)) return { reply: identityReply(), intent: 'identity' };

  /* ---- Remember Commands ---- */
  mm = m.match(/^(?:remember|note)(?:\s+that|\s+this)?\s+(.{3,2000})/i);
  if (mm) return { reply: await rememberReply(mm[1].trim()), intent: 'remember' };

  /* ---- Web learning URL ---- */
  const urlMatch = m.match(/https?:\/\/[^\s"'<>\]]+/i);
  if (urlMatch && (/\b(read|learn|summaris[ez]|fetch|get|open|check|ingest)\b/i.test(m) || m === urlMatch[0])) {
    return { reply: await learnReply(urlMatch[0].replace(/[.,;!?]+$/, '')), intent: 'learn' };
  }

  return null;
}

const titleCase = (s) => { const t = String(s || '').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; };

/* ════════════════════════════════════════════════════════════════════════
   4. AUTONOMOUS MULTI-STEP SCHEDULER
   ════════════════════════════════════════════════════════════════════════ */
const PLANNER_PATTERNS = [
  /\bplan\s+(?:out\s+)?(?:my\s+|the\s+)?day\b/i,
  /\bplan\s+(?:my\s+|for\s+)?tomorrow\b/i,
  /\bcreate\s+(?:my\s+|the\s+)?schedule\b/i,
  /\bbuild\s+(?:a|my|the)\s+(?:full\s+|weekly\s+|daily\s+)?plan\b/i,
  /\b(?:a|my)\s+weekly\s+plan\b/i,
  /\borganize|organise\b.*\b(?:this|my|the|next)\s+(?:week|day)\b/i,
  /\bplan\s+(?:my|the|this|next)\s+week\b/i,
  /\bschedule\s+(?:my|the|this)\s+(?:whole\s+)?(?:day|week)\b/i,
];

function isPlannerRequest(msg) {
  const m = String(msg || '');
  if (/^(?:what|who|why|define|explain|how\s+does)\b/i.test(m)) return false;   // questions about plans ≠ plan requests
  return PLANNER_PATTERNS.some(p => p.test(m));
}

/* Which day(s) should the plan cover? "plan my day tomorrow" → 1 day; weekly → next 5 weekdays. */
function planTargetDays(msg, tz) {
  const m = String(msg || '').toLowerCase();
  const todayKey = dayKey(Date.now(), tz);
  if (/week|weekly/.test(m)) {
    const days = [];
    let i = 1;
    while (days.length < 5 && i < 14) {
      const k = dayKeyAdd(todayKey, i);
      const dow = dayKeyDow(k);
      if (dow !== 0 && dow !== 6) days.push(k);
      i++;
    }
    return { scope: 'week', days };
  }
  const offset = /\btoday\b/.test(m) ? 0 : 1;   // "plan my day" defaults to tomorrow
  return { scope: 'day', days: [dayKeyAdd(todayKey, offset)] };
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/* Place sequential blocks into the work day, jumping over existing calendar entries. */
function placeBlocks(blocks, busy, workStart, workEnd, bufferMs = 15 * 60000) {
  const placed = [];
  let t = workStart;
  const conflicts = busy.slice().sort((a, b) => a.start - b.start);
  for (const b of blocks) {
    let start = Math.max(t, b.earliest || 0);
    let moved = true;
    while (moved) {
      moved = false;
      for (const c of conflicts) {
        if (start < c.end && start + b.duration > c.start) { start = c.end + bufferMs; moved = true; }
      }
    }
    if (start + b.duration <= workEnd + bufferMs) {
      placed.push({ ...b, start, end: start + b.duration });
      t = start + b.duration + bufferMs;
    }
  }
  return placed;
}

/**
 * Generate a full day (or week) plan: wake-up brief, focus blocks for prioritised tasks,
 * a meeting window that never double-books, triage windows, business/day-job blocks and
 * 15-minute buffers. Previous unconfirmed planner events for the same days are replaced.
 */
async function generateSchedule(message) {
  const cfg = cfgm.load();
  const db = dbm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const rhythm = cfg.rhythm || { wakeHour: 6, workStartHour: 8, workEndHour: 17, sleepHour: 22 };
  const { scope, days } = planTargetDays(message, tz);
  const planId = `plan-${Date.now()}`;

  /* 1. Unfinished tasks, high → medium → low (stable within a priority). */
  const tasks = (db.tasks || db.inbox || []).filter(t => !t.done)
    .slice()
    .sort((a, b) => ((PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)) || ((a.ts || a.createdAt || 0) - (b.ts || b.createdAt || 0)));

  /* 2. Unread emails + messages that need action (they feed the triage windows). */
  const unreadEmails = (db.emails || []).filter(e => !e.read);
  const actionMsgs = (db.messages || []).filter(x => !x.read && (x.priority === 'high' || x.priority === 'medium' || /\b(please|confirm|reply|respond|send|invoice|order|urgent)\b/i.test(x.text || '')));

  /* 3. Replace any previous unconfirmed plan for these days (iterative re-planning). */
  const daySet = new Set(days);
  db.events = (db.events || []).filter(e => !(e.source === 'planner' && !e.confirmed && daySet.has(dayKey(e.start, tz))));

  const created = [];
  let cursor = 0;
  for (const day of days) {
    const isToday = day === dayKey(Date.now(), tz);
    const workStart = zonedTime(day, rhythm.workStartHour, 0, tz);
    const workEnd = zonedTime(day, rhythm.workEndHour, 0, tz);
    const sleepAt = zonedTime(day, rhythm.sleepHour, 0, tz);

    /* Existing calendar entries for the day (never double-booked, never moved). */
    const busy = (db.events || [])
      .filter(e => dayKey(e.start, tz) === day && e.source !== 'planner')
      .map(e => ({ start: e.start, end: e.end || e.start + 36e5, title: e.title }));

    /* Wake-up brief — fixed at the rhythm's wake hour. */
    const briefAt = Math.max(zonedTime(day, rhythm.wakeHour, 0, tz), isToday ? Date.now() : 0);
    created.push({
      id: `${planId}-${day}-brief`, planId, planDay: day, title: 'Wake-up brief — ARIA morning summary',
      start: briefAt, end: briefAt + 20 * 60000, context: 'day-job', source: 'planner', kind: 'brief', confirmed: false
    });

    /* Work-day blocks, in executive order. Tasks are consumed as they are scheduled so a
       weekly plan spreads them across days instead of repeating the same list. */
    const remaining = tasks.slice(cursor);
    const highOfDay = remaining.filter(t => t.priority === 'high').slice(0, 2);
    const restOfDay = remaining.filter(t => t.priority !== 'high');
    const bizRest = restOfDay.filter(t => t.context === 'business').slice(0, 2);
    const jobRest = restOfDay.filter(t => t.context !== 'business').slice(0, 2);
    cursor += highOfDay.length + bizRest.length + jobRest.length;

    const blocks = [];
    if (highOfDay[0]) blocks.push({ title: `Deep work: ${snippet(highOfDay[0].title, 60)}`, duration: 2 * 3600000, context: highOfDay[0].context === 'business' ? 'business' : 'day-job', kind: 'focus' });
    blocks.push({ title: `Inbox triage — ${unreadEmails.length} unread email${unreadEmails.length === 1 ? '' : 's'}, ${actionMsgs.length} message${actionMsgs.length === 1 ? '' : 's'}`, duration: 30 * 60000, context: 'day-job', kind: 'triage' });
    blocks.push({ title: 'Meetings & calls window', duration: 3600000, context: 'day-job', kind: 'meetings', earliest: workStart + 3 * 3600000 });
    if (highOfDay[1]) blocks.push({ title: `Deep work: ${snippet(highOfDay[1].title, 60)}`, duration: 2 * 3600000, context: highOfDay[1].context === 'business' ? 'business' : 'day-job', kind: 'focus' });
    if (bizRest.length) blocks.push({ title: `Business block: ${snippet(bizRest.map(t => t.title).join(', '), 60)}`, duration: 3600000, context: 'business', kind: 'business' });
    if (jobRest.length) blocks.push({ title: `Day-job block: ${snippet(jobRest.map(t => t.title).join(', '), 60)}`, duration: 3600000, context: 'day-job', kind: 'dayjob' });
    blocks.push({ title: 'End-of-day triage — inbox zero', duration: 30 * 60000, context: 'day-job', kind: 'triage', earliest: workEnd - 30 * 60000 });

    const placed = placeBlocks(blocks, busy, workStart, workEnd);
    for (const b of placed) {
      created.push({
        id: `${planId}-${day}-${created.length}`, planId, planDay: day,
        title: b.title, start: b.start, end: b.end, context: b.context, source: 'planner', kind: b.kind, confirmed: false
      });
    }
  }

  for (const ev of created) (db.events = db.events || []).push(ev);
  brain.buildIndex();

  /* 4. Park the plan as pending so "confirm the plan" / refinements can act on it. */
  const conv = convState(db);
  conv.pendingPlan = { planId, days, scope, ts: Date.now() };

  const label = scope === 'week' ? `the week ahead (${days[0]} → ${days[days.length - 1]})` : dayLabel(zonedTime(days[0], 12, 0, tz), tz);
  const focusCount = created.filter(e => e.kind === 'focus').length;
  const summary = [
    `🗓️ **Plan ready — ${label}**`,
    '',
    `I built your schedule around your rhythm (up at ${String(rhythm.wakeHour).padStart(2, '0')}:00, ${String(rhythm.workStartHour).padStart(2, '0')}:00–${String(rhythm.workEndHour).padStart(2, '0')}:00 focus window) and drafted **${created.length} calendar blocks**:`,
    '',
    ...created.filter(e => e.planDay === days[0]).map(e => `- ${timeStr(e.start, tz)}–${timeStr(e.end, tz)} — ${e.title}${e.context === 'business' ? ' _[business]_' : ''}`),
    ...(scope === 'week' ? [`\n…and ${created.length - created.filter(e => e.planDay === days[0]).length} more blocks across the remaining ${days.length - 1} weekdays.`] : []),
    '',
    `${tasks.filter(t => !t.done).length} open tasks on file, ${focusCount} deep-work block${focusCount === 1 ? '' : 's'} scheduled, ${unreadEmails.length} unread email${unreadEmails.length === 1 ? '' : 's'} triaged twice daily. Existing meetings are respected — nothing is double-booked.`,
    '',
    `**Shall I lock this plan in?** Say "confirm the plan" — or tell me what to change, e.g. "move the standup to 10am" or "remove the inbox triage".`
  ].join('\n');

  await dbm.saveNow();
  return summary;
}

async function confirmPlan() {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const conv = convState(db);
  const planId = conv.pendingPlan && conv.pendingPlan.planId;
  let n = 0;
  for (const e of db.events || []) {
    if (e.source === 'planner' && (!planId || e.planId === planId)) { e.confirmed = true; n++; }
  }
  conv.pendingPlan = null;
  await dbm.saveNow();
  return `✅ **Plan locked in** — ${n} block${n === 1 ? '' : 's'} are now on your calendar. I'll remind you as each one comes up. Want any last tweaks? Just say "move X to Y".`;
}

async function cancelPlan() {
  const db = dbm.load();
  const conv = convState(db);
  const planId = conv.pendingPlan && conv.pendingPlan.planId;
  const before = (db.events || []).length;
  db.events = (db.events || []).filter(e => !(e.source === 'planner' && (!planId || e.planId === planId) && !e.confirmed));
  const removed = before - (db.events || []).length;
  conv.pendingPlan = null;
  brain.buildIndex();
  await dbm.saveNow();
  return `🗑️ Plan cancelled — ${removed} drafted block${removed === 1 ? '' : 's'} removed. Your own calendar entries were never touched. Say "plan my day" whenever you want a fresh one.`;
}

/* Fuzzy-find an event by the user's words ("the standup", "inbox triage", "meeting with kamau"). */
function findEventByWords(query, tz, opts = {}) {
  const db = dbm.load();
  const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !/^(the|and|for|with|my|our|from|meeting|event|block)$/i.test(w));
  if (!words.length) return null;
  const now = Date.now();
  const candidates = (db.events || []).filter(e => {
    if (opts.plannerOnly && e.source !== 'planner') return false;
    const title = String(e.title || '').toLowerCase();
    return words.every(w => title.includes(w)) || words.some(w => title.includes(w));
  }).map(e => {
    const title = String(e.title || '').toLowerCase();
    const matched = words.filter(w => title.includes(w)).length;
    /* Prefer events matching every word, then future ones, then the earliest. */
    const future = e.start >= now - 12 * 3600000 ? 0 : 1;
    return { e, score: matched * 10 - future * 5 - (e.source === 'planner' ? 0.5 : 0) - e.start / 1e13 };
  }).sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].e : null;
}

/* "move the standup to 10am" — keep the day, change the wall-clock time. */
async function moveEvent(what, hour, minute, ampm, tz) {
  const ev = findEventByWords(what, tz);
  if (!ev) return null;
  let h = hour;
  if (!ampm && hour <= 7) h = hour + 12;          // "move the review to 3" → 15:00
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const day = dayKey(ev.start, tz);
  const newStart = zonedTime(day, h, minute || 0, tz);
  const duration = (ev.end || ev.start + 36e5) - ev.start;
  const clash = (dbm.load().events || []).find(e => e.id !== ev.id && e.start < newStart + duration && (e.end || e.start + 36e5) > newStart);
  ev.start = newStart;
  ev.end = newStart + duration;
  if (ev.source === 'planner' && ev.kind === 'brief') ev.kind = 'moved';
  brain.buildIndex();
  await dbm.saveNow();
  return `⏰ **Moved:** "${ev.title}" now starts at ${timeStr(newStart, tz)} on ${dayLabel(newStart, tz)}.${clash ? ` ⚠️ Heads up — it now overlaps "${clash.title}".` : ' No double booking.'}`;
}

/* "remove the inbox triage" — drop the matching event(s) from the plan/calendar. */
async function removeEvent(what, tz) {
  const db = dbm.load();
  const words = String(what || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !/^(the|and|for|with|my|our|from)$/i.test(w));
  if (!words.length) return null;
  const matches = (db.events || []).filter(e => {
    const title = String(e.title || '').toLowerCase();
    const hit = words.every(w => title.includes(w)) || (words.length === 1 && title.includes(words[0]));
    return hit && e.start >= Date.now() - 24 * 3600000;
  });
  if (!matches.length) return null;
  const removed = matches.slice();
  db.events = (db.events || []).filter(e => !removed.includes(e));
  brain.buildIndex();
  await dbm.saveNow();
  const names = [...new Set(removed.map(e => `"${e.title}"`))].slice(0, 3).join(', ');
  return `🗑️ **Removed:** ${names} from your schedule. ${removed[0].source === 'planner' ? 'The rest of the plan still stands — say "confirm the plan" to lock it in.' : ''}`.trim();
}

/* ════════════════════════════════════════════════════════════════════════
   5. SPEECH DISCRETION — TTS-safe twin of every reply
   ════════════════════════════════════════════════════════════════════════ */

/* Redact secrets, PINs, card/account numbers, emails & phone numbers.
   Applied ONLY to the spoken twin — the on-screen reply keeps the full detail. */
function redactSensitive(text) {
  return String(text || '')
    .replace(/\b(?:sk|pk|rk|gh|gl|npm)[-_](?:live|test|pub)?[-_]?[A-Za-z0-9_-]{8,}\b/gi, 'a secret key')
    .replace(/\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\b(?:\s+is|:|=)?\s*[\w.+-]{4,}/gi, (m, w) => `${w} redacted`)
    .replace(/\bm[-\s]?pesa\s+pin\b(?:\s+is|:|=)?\s*\d{4,5}/gi, 'your M-Pesa PIN, redacted')
    .replace(/\bpin\b(?:\s+is|:|=)?\s*(\d{4,5})\b/gi, 'a PIN, redacted')
    .replace(/\b(?:\d[ -]?){13,16}\b/g, 'a card number')
    .replace(/\b(?:\+?254|0)(?:[ -]?\d){8,9}\b/g, 'a phone number')
    .replace(/\b[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}\b/gi, 'an email address')
    .replace(/\b\d{8,14}\b/g, 'a long account number');
}

/* Discretion mode: never read full inboxes or long lists aloud — summarise instead. */
function applyDiscretion(text) {
  const t = String(text || '');
  const lines = t.split('\n');
  const items = lines.filter(l => /^\s*[-*•]\s+/.test(l));
  const head = (lines.find(l => l.trim() && !/^\s*[-*•]\s+/.test(l)) || '').replace(/\*\*/g, '').trim();
  const tail = lines.slice((() => { let last = -1; lines.forEach((l, i) => { if (/^\s*[-*•]\s+/.test(l)) last = i; }); return last + 1; })())
    .filter(l => l.trim()).join(' ').replace(/\*\*/g, '').trim();

  /* Full email contents are never spoken — a count plus a nudge to the app instead. */
  if (/unread\s*(?:inbox|emails?)|inbox.*unread/i.test(head)) {
    const n = (head.match(/\((\d+)\)/) || [])[1] || items.length || 'some';
    return `You have ${n} unread — check the app for the details.`;
  }

  /* Long lists: "you have 15 open tasks — the top 3 are …". */
  if (items.length > 5) {
    const top3 = items.slice(0, 3).map(i => i.replace(/^\s*[-*•]\s+/, '').replace(/\*\*/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim()).join('; ');
    const extra = items.length - 3;
    return `${head ? head + ' ' : ''}You have ${items.length} open items — the top 3 are: ${top3}. Plus ${extra} more on your screen.${tail ? ' ' + tail : ''}`;
  }
  return t;
}

/**
 * Compose the TTS-safe twin of a reply. Order: profanity out → markdown out →
 * secrets redacted → discretion summaries. Emojis are KEPT here so the client's
 * speech engine can translate them into natural words (📅 → "calendar").
 */
function toSpeechText(reply, opts = {}) {
  let t = cleanProfanity(String(reply || ''));
  t = t
    .replace(/```[\s\S]*?```/g, ' I sent the code to your screen instead of reading it. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, 'link')
    .replace(/\bwww\.\S+/gi, 'link')
    .replace(/[~^|]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
  const hadSecret = /\b(?:pin|password|passwd|pwd|token|secret|api\s*key|apikey|cvv|mpesa|card|otp)\b/i.test(String(reply || ''));
  t = redactSensitive(t);
  if (hadSecret) t = t.replace(/\b\d{4,8}\b/g, 'a number');   // no secret value survives, even echoed back
  if (opts.discretion !== false) t = applyDiscretion(t);
  return t.replace(/\n{2,}/g, '. ').replace(/\s{2,}/g, ' ').trim();
}

/* ════════════════════════════════════════════════════════════════════════
   6. OFFLINE ENGINE (heuristic answers when no LLM is reachable)
   ════════════════════════════════════════════════════════════════════════ */

/* Which calendar day is the user asking about? "…tomorrow", "…friday", "next week", today. */
function parseQueryDay(text, tz) {
  const m = String(text || '').toLowerCase();
  const todayKey = dayKey(Date.now(), tz);
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  if (/\byesterday\b/.test(m)) return { key: dayKeyAdd(todayKey, -1), label: 'yesterday' };
  if (/\btomorrow\b/.test(m)) return { key: dayKeyAdd(todayKey, 1), label: 'tomorrow' };
  const wd = m.match(/\b(?:on|this|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const todayDow = dayKeyDow(todayKey);
    const delta = (days[wd[1]] - todayDow + 7) % 7 || 7;
    return { key: dayKeyAdd(todayKey, delta), label: wd[1].charAt(0).toUpperCase() + wd[1].slice(1) };
  }
  return { key: todayKey, label: 'today' };
}

async function offlineEngine(msg, context, engineStatus) {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const m = String(msg || '').toLowerCase();

  if (/^(hi|hello|hey|good morning|good afternoon|good evening|sup|yo)\b/.test(m)) {
    return `Hello ${(cfg.owner && cfg.owner.name) || 'there'}! I'm ARIA. Ask me anything about your day, work, or ask me to search the web for any topic.`;
  }

  if (/\b(schedule|calendar|day look|agenda|meetings|what('s| is) on|my day|free|busy)\b/.test(m)) {
    const day = parseQueryDay(m, tz);
    const events = (db.events || []).filter(e => dayKey(e.start, tz) === day.key).sort((a, b) => a.start - b.start);
    if (!events.length) return `You have no events scheduled for ${day.label}. Your calendar is clear!`;
    return `**Schedule for ${day.label} (${day.key})**:\n` + events.map(e => `- ${timeStr(e.start, tz)}: ${e.title} (${e.source || 'calendar'})`).join('\n');
  }

  if (/\b(priorit|urgent|important|to do|tasks|focus)\b/.test(m)) {
    const open = (db.inbox || []).filter(i => !i.done);
    const items = open.slice(0, 5);
    if (!items.length) return "No urgent priorities right now. All tasks are clear!";
    return `**Top Priorities** (${open.length} open):\n` + items.map(i => `- [${i.priority || 'medium'}] ${i.title}`).join('\n');
  }

  if (/\b(inbox|email|emails|unread|messages)\b/.test(m)) {
    const unreadEmails = (db.emails || []).filter(e => !e.read);
    const top = unreadEmails.slice(0, 3);
    if (!unreadEmails.length) return "Your inbox is clear — no unread emails.";
    return `**Unread Inbox** (${unreadEmails.length}):\n` + top.map(e => `- **${e.fromName || e.from}**: ${e.subject}`).join('\n');
  }

  if (/\b(slack|whatsapp|chat)\b/.test(m)) {
    const chats = (db.messages || []).slice(-5);
    if (!chats.length) return "No recent chat messages found.";
    return `**Recent Messages**:\n` + chats.map(c => `- [${c.channel || c.source}] **${c.from}**: ${snippet(c.text, 60)}`).join('\n');
  }

  if (/\b(business|orders|suppliers|money|revenue|sales)\b/.test(m)) {
    const bizEvents = (db.events || []).filter(e => e.context === 'business');
    const bizEmails = (db.emails || []).filter(e => e.context === 'business');
    return `**Business snapshot** 🏪\n\n*Upcoming events*` + (bizEvents.map(e => `\n- ${e.title}`).join('') || '\n- None') + `\n\n*Emails*` + (bizEmails.map(e => `\n- ${e.subject}`).join('') || '\n- None');
  }

  // 1. Check local second brain with HIGH confidence threshold to avoid false positives
  const HIGH_CONFIDENCE_SCORE = 3.0;
  const hits = brain.search(msg, 3);
  const strongHits = (hits || []).filter(h => h.score >= HIGH_CONFIDENCE_SCORE);

  if (strongHits.length > 0) {
    return 'Here is what I found in your brain:\n\n' + strongHits.map(h => '- **' + h.title + '**: ' + snippet(h.snippet, 180)).join('\n\n');
  }

  // 2. AUTOMATIC LIVE WEB SEARCH — if brain has no high-confidence match, search the internet
  try {
    const webHits = (await websearch.searchWeb(msg, 3)).map(h => ({ ...h, title: cleanProfanity(h.title), snippet: cleanProfanity(h.snippet) }));
    if (webHits && webHits.length > 0) {
      // Ingest top result into Supabase in background
      if (webHits[0].url && webHits[0].url.startsWith('http')) {
        weblearn.learnFromUrl(webHits[0].url).catch(() => {});
      }

      let reply = '🌐 **Live Web Search Results:**\n\n';
      reply += webHits.map(h => '- **' + h.title + '**\n  ' + (h.snippet || 'Read full source online.') + '\n  🔗 [' + h.source + '](' + h.url + ')').join('\n\n');
      reply += '\n\n_Sources: ' + webHits.map(h => h.source).filter(Boolean).join(', ') + '_';
      return reply;
    }
  } catch (_) {}

  // 3. Show weak brain hits if we have any (better than nothing)
  if (hits && hits.length > 0) {
    return 'I did not find an exact match on the web, but here is what I have in your brain:\n\n' +
      hits.map(h => '- **' + h.title + '**: ' + snippet(h.snippet, 180)).join('\n\n') +
      '\n\n_Try saying "search for ..." or "look up ..." for a live web search._';
  }

  return 'I could not find information about that in your brain or on the web. You can teach me by saying "remember that ...", or try "search for ..." to search the web!';
}

async function setName(name) {
  name = String(name).trim().replace(/\s+/g, ' ').slice(0, 40);
  await cfgm.save({ owner: { name } });
  brain.ingestNote({ title: 'My name is ' + name, content: 'My name is ' + name + '. Please call me ' + name + ' from now on.', source: 'assistant', tags: ['identity'] });
  brain.buildIndex();
  await dbm.saveNow();
  return `Got it — I'll call you **${name}** from now on. I saved it in Settings and wrote it into my brain.`;
}

function identityReply() {
  const cfg = cfgm.load();
  const name = (cfg.owner && cfg.owner.name) || 'Boss';
  const where = cfg.owner && cfg.owner.location && cfg.owner.location.label ? `${cfg.owner.location.label}, ${cfg.owner.timezone}` : (cfg.owner ? cfg.owner.timezone : 'Africa/Nairobi');
  const hits = brain.search(name, 3).filter(h => !/^day log/i.test(h.title));
  let out = `Your name is **${name}** — stored in Settings → Rhythm and remembered in my brain. You're in ${where}.\n\n`;
  if (hits.length) out += `What I know about you so far:\n` + hits.map(h => `- **${h.title}** _[${h.kind}]_ — ${snippet(h.snippet, 140)}`).join('\n');
  return out;
}

async function rememberReply(content) {
  const note = brain.ingestNote({ title: snippet(content, 80), content, source: 'assistant', tags: ['memory'] });
  brain.buildIndex();
  await dbm.saveNow();
  const topic = extractTopics(content, 1)[0] || 'that';
  return `🧠 Remembered: "${snippet(content, 160)}" — saved to brain. Ask me "what do you know about ${topic}?" anytime.`;
}

async function learnReply(url) {
  try {
    const note = await weblearn.learnFromUrl(url);
    return `📚 Done — I read **${note.title}**\n\n${snippet(note.content, 280)}`;
  } catch (e) {
    return `⚠️ Could not read page: ${e.message}`;
  }
}

module.exports = {
  respond, offlineEngine, isWebSearchQuery, isPersonalQuery,
  /* conversation memory */
  resolveFollowUp, recentHistory, buildMemory, convState, classifyQuery,
  /* autonomous scheduler */
  isPlannerRequest, planTargetDays, generateSchedule, confirmPlan, cancelPlan, moveEvent, removeEvent, findEventByWords,
  /* speech discretion */
  toSpeechText, redactSensitive, applyDiscretion, parseQueryDay
};
