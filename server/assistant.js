'use strict';
/**
 * ARIA Assistant — deterministic intent routing + LLM fallback (Ollama or built-in offline engine).
 */
const dbm = require('./db');
const brain = require('./brain');
const cfgm = require('./config');
const weblearn = require('./weblearn');
const { llmChat, llmStatus } = require('./llm');
const { dayKey, timeStr, dayLabel, snippet, minutesOfDay, extractTopics } = require('./util');

const SYSTEM_PROMPT = `You are ARIA, the user's private executive assistant inside ARIA OS.
You manage their day job and their business. You are concise, proactive, well-organized.
Use the provided CONTEXT (calendar, emails, chats, second-brain notes) to answer the user's query.
If something is unknown, say so and suggest what to check. Never invent meetings or emails.`;

async function respond(message) {
  const cfg = cfgm.load();
  const db = dbm.load();
  const engine = llmStatus();

  // Record user message
  db.upsert('chats', { id: `chat-${Date.now()}-u`, role: 'user', content: message, ts: Date.now() });

  // Deterministic "teach me" intents run FIRST, for every engine (Ollama included), so
  // identity, memories and website-learning behave identically everywhere.
  const pre = await routeIntent(String(message || ''));
  let reply, source;
  if (pre) {
    reply = pre;
    source = 'intent';
  } else {
    const context = brain.contextPack(message);
    const { text, engine: usedEngine } = await llmChat(
      SYSTEM_PROMPT,
      `CONTEXT:\n${context}\n\nCURRENT TIME: ${dayLabel(Date.now(), cfg.owner.timezone)} ${timeStr(Date.now(), cfg.owner.timezone)} (${cfg.owner.timezone})\n\nUSER: ${message}`
    );
    if (text) {
      reply = text;
      source = usedEngine;
    } else {
      reply = offlineEngine(message, context, engine);
      source = 'offline-engine';
    }
  }

  db.upsert('chats', { id: `chat-${Date.now()}-a`, role: 'assistant', content: reply, ts: Date.now(), engine: source });
  await dbm.saveNow();
  return { reply, engine: source, llm: engine };
}

/* ---------- Deterministic intents: identity, memory, website learning ---------- */

  // --- ACTION: Schedule / Add Event ---
  let mm = m.match(/^(?:schedule|add event|create meeting|meeting with)\s+(.+)$/i);
  if (mm) {
    const details = mm[1].trim();
    const eventId = `event-${Date.now()}`;
    const cfg = cfgm.load();
    const tz = cfg.owner.timezone || 'Africa/Nairobi';
    const tomorrow = /tomorrow/i.test(details);
    const start = Date.now() + (tomorrow ? 86400000 : 3600000);
    const newEvent = {
      id: eventId,
      title: details.replace(/tomorrow|today|at \d+(:\d+)?(am|pm)?/gi, '').trim() || 'Scheduled Meeting',
      start,
      end: start + 3600000,
      context: /client|order|supplier|money|biz/i.test(details) ? 'business' : 'day-job',
      source: 'assistant'
    };
    db.events = db.events || [];
    db.events.push(newEvent);
    await dbm.saveNow();
    brain.buildIndex();
    return `📅 **Event Scheduled:** "${newEvent.title}" on ${dayLabel(newEvent.start, tz)} at ${timeStr(newEvent.start, tz)}.`;
  }

  // --- ACTION: Add Priority Task / To-Do ---
  mm = m.match(/^(?:add task|todo|remind me to|prioritize|create task):?\s+(.+)$/i);
  if (mm) {
    const taskTitle = mm[1].trim();
    const taskId = `task-${Date.now()}`;
    const isHigh = /urgent|important|asap|critical/i.test(taskTitle);
    db.inbox = db.inbox || [];
    db.inbox.unshift({
      id: taskId,
      title: taskTitle,
      priority: isHigh ? 'high' : 'medium',
      done: false,
      ts: Date.now(),
      context: 'day-job'
    });
    await dbm.saveNow();
    return `✅ **Task Added:** "${taskTitle}" (Priority: ${isHigh ? '🔥 High' : '⚡ Normal'})`;
  }

  // --- ACTION: Draft Email ---
  mm = m.match(/^(?:draft email to|send email to|email)\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-z]+)\s+(?:about|saying|subject)\s+(.+)$/i);
  if (mm) {
    const to = mm[1];
    const rest = mm[2];
    db.emails = db.emails || [];
    const draft = {
      id: `draft-${Date.now()}`,
      to,
      subject: snippet(rest, 50),
      body: rest,
      from: cfgm.load().owner.name || 'ARIA User',
      draft: true,
      ts: Date.now()
    };
    db.emails.unshift(draft);
    await dbm.saveNow();
    return `✉️ **Email Draft Created** to **${to}**:\n*Subject:* ${draft.subject}\n*Body:* ${draft.body}`;
  }

  // --- ACTION: Complete Task ---
  mm = m.match(/^(?:complete task|mark done|finish task|done with)\s+(.+)$/i);
  if (mm) {
    const q = mm[1].toLowerCase().trim();
    const item = (db.inbox || []).find(t => !t.done && (t.title || '').toLowerCase().includes(q));
    if (item) {
      item.done = true;
      await dbm.saveNow();
      return `🎉 **Completed Task:** "${item.title}" marked as done!`;
    }
  }

const CALL_ME_BLOCK = /^(later|tomorrow|now|soon|when|if|after|before|back|again|next|first|sometime|once)$/i;

async function routeIntent(msg) {
  const m = String(msg || '').trim();
  if (!m) return null;

  // "my name is X" / "call me X" → save the name into Settings AND the brain
  let mm = m.match(/^my name is\s+(.{2,60}?)\s*$/i);
  if (mm) return await setName(mm[1].replace(/[.!?]+$/, '').trim());
  mm = m.match(/^(?:please\s+)?call me\s+([a-z]+(?:[ -][a-z]+){0,2})\s*[.!?]*$/i);
  if (mm && !CALL_ME_BLOCK.test(mm[1].split(/[\s-]+/)[0].trim())) return await setName(mm[1].trim());

  // "what is my name" / "who am i" / "what do you know about me"
  if (/^(what(?:'s| is) my name|who am i|do you know (?:my name|who i am)|what do you know about me)\??$/i.test(m)) return identityReply();

  // "remember that …" / "note that …" → permanent memory
  mm = m.match(/^(?:remember|note)(?:\s+that|\s+this)?\s+(.{3,2000})/i);
  if (mm) return await rememberReply(mm[1].trim());

  // "read this website https://…" / "learn from https://…" / bare URL
  const urlMatch = m.match(/https?:\/\/[^\s"'<>)\]]+/i);
  if (urlMatch && (/\b(read|learn|summaris[ez]|fetch|get|open|check|ingest)\b/i.test(m) || m === urlMatch[0])) {
    return await learnReply(urlMatch[0].replace(/[.,;!?]+$/, ''));
  }
  return null;
}

async function setName(name) {
  name = String(name).trim().replace(/\s+/g, ' ').slice(0, 40);
  if (name.length < 2) return 'Tell me the name too — e.g. “my name is Francis”.';
  await cfgm.save({ owner: { name } });
  brain.ingestNote({ title: `My name is ${name}`, content: `My name is ${name}. Please call me ${name} from now on.`, source: 'assistant', tags: ['identity'] });
  brain.buildIndex();
  await dbm.saveNow();
  return `Got it — I'll call you **${name}** from now on. I saved it in Settings (Rhythm) and wrote it into my brain, so it survives restarts.`;
}

function identityReply() {
  const cfg = cfgm.load();
  const name = cfg.owner.name || 'Boss';
  const where = cfg.owner.location && cfg.owner.location.label
    ? `${cfg.owner.location.label}, ${cfg.owner.timezone}`
    : cfg.owner.timezone;
  const hits = brain.search(name, 3).filter(h => !/^day log/i.test(h.title));
  let out = `Your name is **${name}** — stored in Settings → Rhythm and remembered in my brain. You're in ${where}.\n\n`;
  if (hits.length) out += `What I know about you so far:\n${hits.map(h => `- **${h.title}** _[${h.kind}]_ — ${snippet(h.snippet, 140)}`).join('\n')}`;
  else out += `That's all I have on you yet. Teach me anything: say **“remember that …”**, capture it in Second Brain, or set your details in Settings.`;
  return out;
}

async function rememberReply(content) {
  const note = brain.ingestNote({ title: snippet(content, 80), content, source: 'assistant', tags: ['memory'] });
  brain.buildIndex();
  await dbm.saveNow();
  const topic = (extractTopics(content, 1)[0] || 'that');
  return `🧠 Remembered: “${snippet(content, 160)}” — it's in my brain now. Ask me “what do you know about ${topic}?” any time.`;
}

async function learnReply(url) {
  try {
    const note = await weblearn.learnFromUrl(url);
    return `📚 Done — I read **${note.title}**\n\nSaved to the second brain (source: web · tags: ${(note.tags || []).join(', ')}). Here's how it starts:\n\n${snippet(note.content, 300)}\n\nAsk me “what do you know about …” and I'll answer from it.`;
  } catch (e) {
    return `⚠️ I couldn't read that page: ${e.message}. Check it's a public https page and try again.`;
  }
}

/* ---------- Offline engine: intent routing over real data ---------- */
function offlineEngine(msg, context, engineStatus) {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone;
  const m = String(msg || '').toLowerCase();

  // Greetings / status
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|sup|yo)\b/.test(m)) {
    const name = cfg.owner.name || 'there';
    return `Hello ${name}! I'm ARIA, running locally. Ask me what your day looks like, what your priorities are, or search your brain.`;
  }

  // Schedule / Day look
  if (/\b(schedule|calendar|day look|agenda|meetings|what('s| is) on today)\b/.test(m)) {
    const today = dayKey(Date.now(), tz);
    const events = (db.events || []).filter(e => dayKey(e.start, tz) === today).sort((a, b) => a.start - b.start);
    if (!events.length) return "You have no events scheduled for today. A clear calendar!";
    return `**Today's Schedule (${today})**:\n` + events.map(e => `- ${timeStr(e.start, tz)}: ${e.title} (${e.account || e.source || 'calendar'})`).join('\n');
  }

  // Priorities
  if (/\b(priorit|urgent|important|to do|tasks|focus)\b/.test(m)) {
    const items = (db.inbox || []).filter(i => !i.done).slice(0, 5);
    if (!items.length) return "No urgent priority items flagged right now.";
    return `**Top Priorities**:\n` + items.map(i => `- [${i.priority || 'medium'}] ${i.title || i.subject || i.text}`).join('\n');
  }

  // Inbox / Emails
  if (/\b(inbox|email|emails|unread|messages)\b/.test(m)) {
    const emails = (db.emails || []).filter(e => !e.read).slice(0, 5);
    if (!emails.length) return "Your inbox is clear — no unread emails.";
    return `**Unread Inbox** (${emails.length}):\n` + emails.map(e => `- **${e.fromName || e.from}**: ${e.subject}`).join('\n');
  }

  // Slack / WhatsApp
  if (/\b(slack|whatsapp|chat)\b/.test(m)) {
    const chats = (db.messages || []).slice(-5);
    if (!chats.length) return "No recent chat messages found.";
    return `**Recent Messages**:\n` + chats.map(c => `- [${c.channel || c.source}] **${c.from}**: ${snippet(c.text, 60)}`).join('\n');
  }

  // Business snapshot
  if (/\b(business|orders|suppliers|money|revenue|sales)\b/.test(m)) {
    const bizEvents = (db.events || []).filter(e => e.context === 'business');
    const bizEmails = (db.emails || []).filter(e => e.context === 'business');
    const bizMsgs = (db.messages || []).filter(e => e.context === 'business');
    return `**Business snapshot** 🏪\n\n*Upcoming business events*\n${bizEvents.map(e => `- ${dayKey(e.start, tz)} ${timeStr(e.start, tz)} — ${e.title}`).join('\n') || '- none' }\n\n*Business emails*\n${bizEmails.map(e => `- ${e.subject} — ${e.fromName}`).join('\n') || '- none'}\n\n*Business chats*\n${bizMsgs.map(x => `- [${x.channel}] ${x.from}: ${snippet(x.text, 80)}`).join('\n') || '- none'}`;
  }

  // Help / capabilities
  if (/\b(help|what can you do|capabilit)/.test(m)) {
    return `I'm ARIA — your executive assistant. Things you can ask me:\n\n- **"What does my day look like?"** — schedule across every calendar\n- **"What are my priorities?"** — ranked by urgency\n- **"How's my inbox?"** — unread, split day-job vs business\n- **"What's happening in Slack/WhatsApp?"**\n- **"What do I know about ___?"** — search your second brain\n- **"Show me the business picture"** — orders, suppliers, money\n- **"Remember that …"** — teach me something permanently\n- **"My name is …"** — I'll remember who you are\n- **"Read this website https://…"** — pull a page into the brain\n\nI reason over your real data. ${engineStatus.activeEngine === 'ollama' ? `Running locally on Ollama (${engineStatus.model}) — fully private. 🟢` : 'Currently on the **built-in offline engine**. Install [Ollama](https://ollama.com), pull a model (e.g. `ollama pull llama3.1`), and I\'ll upgrade myself automatically in Settings → AI. 🔌'}`;
  }

  // Default: retrieval over the brain + fallback
  const hits = brain.search(msg, 3);
  if (hits.length) {
    return `Here is what I found in your brain:\n\n` + hits.map(h => `- **${h.title}**: ${snippet(h.snippet, 180)}`).join('\n\n');
  }

  return "I don't have enough context in my brain or calendar to answer that specifically. You can teach me by saying **“remember that …”** or check Settings.";
}

module.exports = { respond, offlineEngine };
