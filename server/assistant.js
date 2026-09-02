'use strict';
const dbm = require('./db');
const brain = require('./brain');
const cfgm = require('./config');
const weblearn = require('./weblearn');
const { llmChat, llmStatus } = require('./llm');
const { dayKey, timeStr, dayLabel, snippet, extractTopics } = require('./util');

const SYSTEM_PROMPT = `You are ARIA, the user's private executive assistant inside ARIA OS.
You manage their day job and their business. You are concise, proactive, well-organized.
Use the provided CONTEXT (calendar, emails, chats, second-brain notes) to answer the user's query.`;

async function respond(message) {
  const cfg = cfgm.load();
  const db = dbm.load();
  const engine = llmStatus();

  db.upsert('chats', { id: `chat-${Date.now()}-u`, role: 'user', content: message, ts: Date.now() });

  const pre = await routeIntent(String(message || ''));
  let reply, source;
  if (pre) {
    reply = pre;
    source = 'intent';
  } else {
    const context = brain.contextPack(message);
    const { text, engine: usedEngine } = await llmChat(
      SYSTEM_PROMPT,
      `CONTEXT:\n${context}\n\nCURRENT TIME: ${dayLabel(Date.now(), cfg.owner.timezone)} ${timeStr(Date.now(), cfg.owner.timezone)} (&{cfg.owner.timezone})\n\nUSER: ${message}`
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

/* ---------- Advanced NLP Relative Date & Intent Parser ---------- */
function parseRelativeDateTime(text) {
  const now = new Date();
  let targetDate = new Date(now.getTime());
  
  const cleanText = String(text).toLowerCase();
  
  // Date parsing
  if (cleanText.includes('tomorrow')) {
    targetDate.setDate(now.getDate() + 1);
  } else if (cleanText.includes('next monday')) {
    targetDate.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  } else if (cleanText.includes('next tuesday')) {
    targetDate.setDate(now.getDate() + ((2 + 7 - now.getDay()) % 7 || 7));
  } else if (cleanText.includes('next wednesday')) {
    targetDate.setDate(now.getDate() + ((3 + 7 - now.getDay()) % 7 || 7));
  } else if (cleanText.includes('next thursday')) {
    targetDate.setDate(now.getDate() + ((4 + 7 - now.getDay()) % 7 || 7));
  } else if (cleanText.includes('next friday')) {
    targetDate.setDate(now.getDate() + ((5 + 7 - now.getDay()) % 7 || 7));
  } else if (cleanText.includes('on monday')) {
    targetDate.setDate(now.getDate() + (1 + 7 - now.getDay()) % 7);
  } else if (cleanText.includes('on tuesday')) {
    targetDate.setDate(now.getDate() + (2 + 7 - now.getDay()) % 7);
  } else if (cleanText.includes('on wednesday')) {
    targetDate.setDate(now.getDate() + (3 + 7 - now.getDay()) % 7);
  } else if (cleanText.includes('on thursday')) {
    targetDate.setDate(now.getDate() + (4 + 7 - now.getDay()) % 7);
  } else if (cleanText.includes('on friday')) {
    targetDate.setDate(now.getDate() + (5 + 7 - now.getDay()) % 7);
  }

  // Time parsing (matches e.g. "at 3pm", "at 4:30 pm", "at 15:00")
  let hours = 9; // Default 9 AM
  let minutes = 0;
  const timeMatch = cleanText.match(/ats+(d+)(?::(d+))?s*(am|pm)?/);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    if (timeMatch[2]) minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  }
  
  targetDate.setHours(hours, minutes, 0, 0);
  return targetDate.getTime();
}

async function routeIntent(msg) {
  const m = String(msg || '').trim();
  if (!m) return null;
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone || 'Africa/Nairobi';

  // NLP: Schedule Action
  let mm = m.match(/^(?:schedule|add event|create meeting|meeting with|calendar)s+(.+)$/i);
  if (mm) {
    const rawDetails = mm[1].trim();
    const startTime = parseRelativeDateTime(rawDetails);
    
    // Clean up title (remove time markers)
    const cleanTitle = rawDetails
      .replace(/(ats+d+(:d+)?s*(am|pm)?|tomorrow|today|nexts+[a-z]+|ons+[a-z]+)/gi, '')
      .replace(/s+/g, ' ')
      .trim();

    const newEvent = {
      id: `event-${Date.now()}`,
      title: cleanTitle || 'Executive Appointment',
      start: startTime,
      end: startTime + 3600000, // 1 hr default
      context: /client|order|supplier|money|biz|pay/i.test(rawDetails) ? 'business' : 'day-job',
      source: 'assistant'
    };
    db.events = db.events || [];
    db.events.push(newEvent);
    await dbm.saveNow();
    brain.buildIndex();
    return `📅 **Event Scheduled Successfully:**\n*Title:* "${newEvent.title}"\n*Time:* ${dayLabel(newEvent.start, tz)} at ${timeStr(newEvent.start, tz)}.`;
  }

  // NLP: Add Priority Task
  mm = m.match(/^(?:add task|todo|remind me to|prioritize|create task):?s+(.+)$/i);
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
    return `✅ **Task Added to Inbox:** "${db.inbox[0].title}"\n*Priority:* ${isHigh ? '🔥 High Priority' : '⚡ Normal'}`;
  }

  // NLP: Complete Task
  mm = m.match(/^(?:complete task|mark done|finish task|done with)s+(.+)$/i);
  if (mm) {
    const q = mm[1].toLowerCase().trim();
    const item = (db.inbox || []).find(t => !t.done && (t.title || '').toLowerCase().includes(q));
    if (item) {
      item.done = true;
      await dbm.saveNow();
      return `🎉 **Priority Item Completed:** "${item.title}"`;
    }
    return `⚠️ No active tasks matching "${mm[1]}" were found.`;
  }

  // NLP: Draft Email
  mm = m.match(/^(?:draft email to|send email to|email)s+([^s]+)s+(?:about|saying|subject)s+(.+)$/i);
  if (mm) {
    const to = mm[1];
    const bodyText = mm[2];
    db.emails = db.emails || [];
    const draft = {
      id: `draft-${Date.now()}`,
      to,
      subject: snippet(bodyText, 45),
      body: bodyText,
      from: cfg.owner.name || 'ARIA User',
      draft: true,
      ts: Date.now()
    };
    db.emails.unshift(draft);
    await dbm.saveNow();
    return `✉️ **Email Draft Saved:**\n*To:* ${to}\n*Subject:* ${draft.subject}\n*Message:* ${draft.body}`;
  }

  // Identity Commands
  mm = m.match(/^my name iss+(.{2,60}?)s*$/i);
  if (mm) return await setName(mm[1].replace(/[.!?]+$/, '').trim());
  mm = m.match(/^(?:pleases+)?call mes+([a-z]+(?:[ -][a-z]+){0,2})s*[.!?]*$/i);
  if (mm && !CALL_ME_BLOCK.test(mm[1].split(/[s-]+/)[0].trim())) return await setName(mm[1].trim());

  if (/^(what(?:'s| is) my name|who am i|do you know (?:my name|who i am)|what do you know about me)??$/i.test(m)) return identityReply();

  // Remember Commands
  mm = m.match(/^(?:remember|note)(?:s+that|s+this)?s+(.{3,2000})/i);
  if (mm) return await rememberReply(mm[1].trim());

  // Web learning URL
  const urlMatch = m.match(/https?://[^s"'<>)]]+/i);
  if (urlMatch && (/(read|learn|summaris[ez]|fetch|get|open|check|ingest)/i.test(m) || m === urlMatch[0])) {
    return await learnReply(urlMatch[0].replace(/[.,;!?]+$/, ''));
  }

  return null;
}

async function setName(name) {
  name = String(name).trim().replace(/s+/g, ' ').slice(0, 40);
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
  const where = cfg.owner.location && cfg.owner.location.label ? `${cfg.owner.location.label}, ${cfg.owner.timezone}` : cfg.owner.timezone;
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
    return `📚 Done — I read **${note.title}**\n\nSaved to the second brain (source: web · tags: s${(note.tags || []).join(', ')}). Here's how it starts:\n\n${snippet(note.content, 300)}\n\nAsk me “what do you know about …” and I'll answer from it.`;
  } catch (e) {
    return `⚠️ I couldn't read that page: ${e.message}. Check it's a public https page and try again.`;
  }
}

/* ---------- Built-in Heuristic Offline Engine ---------- */
function offlineEngine(msg, context, engineStatus) {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone;
  const m = String(msg || '').toLowerCase();

  if (/^(hi|hello|hey|good morning|good afternoon|good evening|sup|yo)/.test(m)) {
    return `Hello ${cfg.owner.name || 'there'}! I'm ARIA, running locally. Ask me what your day looks like, what your priorities are, or search your brain.`;
  }

  if (/\b(schedule|calendar|day look|agenda|meetings|what('s| is) on today)\b/.test(m)) {
    const today = dayKey(Date.now(), tz);
    const events = (db.events || []).filter(e => dayKey(e.start, tz) === today).sort((a, b) => a.start - b.start);
    if (!events.length) return "You have no events scheduled for today. A clear calendar!";
    return `**Today's Schedule (${today})**:\n` + events.map(e => `- ${timeStr(e.start, tz)}: dots${e.title} (${e.account || e.source || 'calendar'})`).join('\n');
  }

  if (/\b(priorit|urgent|important|to do|tasks|focus)\b/.test(m)) {
    const items = (db.inbox || []).filter(i => !i.done).slice(0, 5);
    if (!items.length) return "No urgent priority items flagged right now.";
    return `**Top Priorities**:\n` + items.map(i => `- [${i.priority || 'medium'}] ${i.title || i.subject || i.text}`).join('\n');
  }

  if (/\b(inbox|email|emails|unread|messages)\b/.test(m)) {
    const emails = (db.emails || []).filter(e => !e.read).slice(0, 5);
    if (!emails.length) return "Your inbox is clear — no unread emails.";
    return `**Unread Inbox** (&{emails.length}):\n` + emails.map(e => `- **${e.fromName || e.from}**: ${e.subject}`).join('\n');
  }

  if (/\b(slack|whatsapp|chat)\b/.test(m)) {
    const chats = (db.messages || []).slice(-5);
    if (!chats.length) return "No recent chat messages found.";
    return `**Recent Messages**:\n` + chats.map(c => `- [${c.channel || c.source}] **${c.from}**: ${snippet(c.text, 60)}`).join('\n');
  }

  if (/\b(business|orders|suppliers|money|revenue|sales)\b/.test(m)) {
    const bizEvents = (db.events || []).filter(e => e.context === 'business');
    const bizEmails = (db.emails || []).filter(e => e.context === 'business');
    const bizMsgs = (db.messages || []).filter(e => e.context === 'business');
    return `**Business snapshot** 🏪\n\n*Upcoming business events*\n${bizEvents.map(e => `- dots${dayKey(e.start, tz)} ${timeStr(e.start, tz)} — ${e.title}`).join('\n') || '- none' }\n\n*Business emails*\n${bizEmails.map(e => `- ${e.subject} — ${e.fromName}`).join('\n') || '- none'}\n\n*Business chats*\n${bizMsgs.map(x => `- [${x.channel}] ${x.from}: ${snippet(x.text, 80)}`).join('\n') || '- none'}`;
  }

  if (/\b(help|what can you do|capabilit)/.test(m)) {
    return `I'm ARIA — your executive assistant. Things you can ask me:\n\n- **"Schedule meeting with Kamau tomorrow at 3pm"**\n- **"Add task: Review Q3 supplier prices"**\n- **"Draft email to user@domain.com saying hello"**\n- **"What does my day look like?"** — schedule across every calendar\n- **"What are my priorities?"** — ranked by urgency\n- **"How's my inbox?"** — unread, split day-job vs business\n- **"Remember that …"** — teach me something permanently\n- **"My name is …"** — I'll remember who you are\n- **"Read this website https://…"** — pull a page into the brain\n\nI reason over your real data.`;
  }

  const hits = brain.search(msg, 3);
  if (hits.length) {
    return `Here is what I found in your brain:\n\n` + hits.map(h => `- **${h.title}**: ${snippet(h.snippet, 180)}`).join('\n\n');
  }

  return "I don't have enough context in my brain or calendar to answer that specifically. You can teach me by saying **“remember that …”** or check Settings.";
}

module.exports = { respond, offlineEngine };
