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

  db.upsert('chats', { id: 'chat-' + Date.now() + '-u', role: 'user', content: message, ts: Date.now() });

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

  db.upsert('chats', { id: 'chat-' + Date.now() + '-a', role: 'assistant', content: reply, ts: Date.now(), engine: source });
  await dbm.saveNow();
  return { reply, engine: source, llm: engine };
}

function parseRelativeDateTime(text) {
  const now = new Date();
  let targetDate = new Date(now.getTime());
  const clean = String(text).toLowerCase();

  if (clean.includes('tomorrow')) targetDate.setDate(now.getDate() + 1);
  else if (clean.includes('next monday')) targetDate.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  else if (clean.includes('next friday')) targetDate.setDate(now.getDate() + ((5 + 7 - now.getDay()) % 7 || 7));

  let hours = 9, minutes = 0;
  const tm = clean.match(/at\s+(\d+)(?::(\d+))?\s*(am|pm)?/);
  if (tm) {
    hours = parseInt(tm[1], 10);
    if (tm[2]) minutes = parseInt(tm[2], 10);
    const ampm = tm[3];
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
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';

  // Schedule Meeting
  let mm = m.match(/^(?:schedule|add event|create meeting|meeting with|calendar)\s+(.+)$/i);
  if (mm) {
    const raw = mm[1].trim();
    const start = parseRelativeDateTime(raw);
    const cleanTitle = raw.replace(/(at\s+\d+(:\d+)?\s*(am|pm)?|tomorrow|today|next\s+[a-z]+|on\s+[a-z]+)/gi, '').trim() || 'Appointment';
    const newEvent = {
      id: 'event-' + Date.now(),
      title: cleanTitle,
      start,
      end: start + 3600000,
      context: /client|order|supplier|money|biz|pay/i.test(raw) ? 'business' : 'day-job',
      source: 'assistant'
    };
    db.events.push(newEvent);
    await dbm.saveNow();
    brain.buildIndex();
    return `📅 **Event Scheduled:** "${newEvent.title}" on ${dayLabel(newEvent.start, tz)} at ${timeStr(newEvent.start, tz)}.`;
  }

  // Add Task
  mm = m.match(/^(?:add task|todo|remind me to|prioritize|create task):?\s+(.+)$/i);
  if (mm) {
    const taskTitle = mm[1].trim();
    const isHigh = /urgent|important|asap|critical|now/i.test(taskTitle);
    db.inbox.unshift({
      id: 'task-' + Date.now(),
      title: taskTitle.replace(/urgent|asap|critical/gi, '').trim(),
      priority: isHigh ? 'high' : 'medium',
      done: false,
      ts: Date.now(),
      context: /client|invoice|sale|biz/i.test(taskTitle) ? 'business' : 'day-job'
    });
    await dbm.saveNow();
    return `✅ **Task Added:** "${db.inbox[0].title}" (Priority: ${isHigh ? '🔥 High' : '⚡ Normal'})`;
  }

  // Complete Task
  mm = m.match(/^(?:complete task|mark done|finish task|done with)\s+(.+)$/i);
  if (mm) {
    const q = mm[1].toLowerCase().trim();
    const item = db.inbox.find(t => !t.done && (t.title || '').toLowerCase().includes(q));
    if (item) {
      item.done = true;
      await dbm.saveNow();
      return `🎉 **Completed Task:** "${item.title}"`;
    }
  }

  // Identity Commands
  mm = m.match(/^my name is\s+(.{2,60}?)\s*$/i);
  if (mm) return await setName(mm[1].replace(/[.!?]+$/, '').trim());
  mm = m.match(/^(?:please\s+)?call me\s+([a-z]+(?:[ -][a-z]+){0,2})\s*[.!?]*$/i);
  if (mm && !/^(later|tomorrow|now|soon|back)$/i.test(mm[1].split(/[\s-]+/)[0].trim())) return await setName(mm[1].trim());

  if (/^(what(?:'s| is) my name|who am i|do you know (?:my name|who i am)|what do you know about me)\??$/i.test(m)) return identityReply();

  // Remember
  mm = m.match(/^(?:remember|note)(?:\s+that|\s+this)?\s+(.{3,2000})/i);
  if (mm) return await rememberReply(mm[1].trim());

  // Web learning URL
  const urlMatch = m.match(/https?:\/\/[^\s"'<>\]]+/i);
  if (urlMatch && (/\b(read|learn|summaris[ez]|fetch|get|open|check|ingest)\b/i.test(m) || m === urlMatch[0])) {
    return await learnReply(urlMatch[0].replace(/[.,;!?]+$/, ''));
  }

  return null;
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
  const name = cfg.owner.name || 'Boss';
  const where = cfg.owner.location && cfg.owner.location.label ? `${cfg.owner.location.label}, ${cfg.owner.timezone}` : cfg.owner.timezone;
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
  return `🧠 Remembered: “${snippet(content, 160)}” — saved to brain. Ask me “what do you know about ${topic}?” anytime.`;
}

async function learnReply(url) {
  try {
    const note = await weblearn.learnFromUrl(url);
    return `📚 Done — I read **${note.title}**\n\n${snippet(note.content, 280)}`;
  } catch (e) {
    return `⚠️ Could not read page: ${e.message}`;
  }
}

function offlineEngine(msg, context, engineStatus) {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone;
  const m = String(msg || '').toLowerCase();

  if (/^(hi|hello|hey|good morning|sup|yo)\b/.test(m)) {
    return `Hello ${cfg.owner.name || 'there'}! I'm ARIA, running locally. Ask me about your day, priorities, or second brain.`;
  }

  if (/\b(schedule|calendar|day look|agenda|meetings|what('s| is) on today)\b/.test(m)) {
    const today = dayKey(Date.now(), tz);
    const events = (db.events || []).filter(e => dayKey(e.start, tz) === today).sort((a, b) => a.start - b.start);
    if (!events.length) return "You have no events scheduled for today. Clear calendar!";
    return `**Today's Schedule (${today})**:\n` + events.map(e => `- ${timeStr(e.start, tz)}: ${e.title} (${e.source || 'calendar'})`).join('\n');
  }

  if (/\b(priorit|urgent|important|to do|tasks|focus)\b/.test(m)) {
    const items = (db.inbox || []).filter(i => !i.done).slice(0, 5);
    if (!items.length) return "No urgent priority items flagged right now.";
    return `**Top Priorities**:\n` + items.map(i => `- [${i.priority || 'medium'}] ${i.title}`).join('\n');
  }

  if (/\b(inbox|email|emails|unread|messages)\b/.test(m)) {
    const emails = (db.emails || []).filter(e => !e.read).slice(0, 5);
    if (!emails.length) return "Your inbox is clear — no unread emails.";
    return `**Unread Inbox** (${emails.length}):\n` + emails.map(e => `- **${e.fromName || e.from}**: ${e.subject}`).join('\n');
  }

  const hits = brain.search(msg, 3);
  if (hits.length) {
    return `From your brain:\n\n` + hits.map(h => `- **${h.title}**: ${snippet(h.snippet, 180)}`).join('\n\n');
  }

  return "I don't have enough context in my brain or calendar to answer that specifically. Teach me with **“remember that …”**!";
}

module.exports = { respond, offlineEngine };
