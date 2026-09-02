'use strict';
/* EXECUTIVE ASSISTANT — "ARIA".
   With Ollama: full natural-language reasoning over your live context.
   Without: a capable offline chief-of-staff (intent routing + retrieval + real data). */
const dbm = require('./db');
const brain = require('./brain');
const cfgm = require('./config');
const weblearn = require('./weblearn');
const { llmChat, llmStatus } = require('./llm');
const { dayKey, timeStr, dayLabel, snippet, minutesOfDay, extractTopics } = require('./util');

const SYSTEM_PROMPT = `You are ARIA, the user's private executive assistant inside ARIA OS.
You manage their day job and their business. You are concise, proactive, well-organized.
Use ONLY the CONTEXT provided plus general knowledge. Prefer bullet points. When giving a plan, be specific with times.
If something is unknown, say so and suggest what to check. Never invent meetings, emails or numbers.`;

async function respond(message) {
  const cfg = cfgm.load();
  const db = dbm.load();
    // Deterministic "teach me" intents run FIRST, for every engine (Ollama included), so
  // identity, memories and website-learning behave identically everywhere.
  const pre = await routeIntent(String(message || ''));
  let reply, source;
  if (pre) {
    reply = pre;
    source = 'intent';
  } else {
    const context = brain.contextPack(message);
    const { text, engine: usedEngine } = await llmChat(SYSTEM_PROMPT, `CONTEXT:\n${context}\n\nCURRENT TIME: ${dayLabel(Date.now(), cfg.owner.timezone)} ${timeStr(Date.now(), cfg.owner.timezone)} (${cfg.owner.timezone})\n\nUSER: ${message}`);
    if (text) { reply = text; source = usedEngine; }
    else { reply = offlineEngine(message, context, engine); source = 'offline-engine'; }
  }
  db.upsert('chats', { id: `chat-${Date.now()}-a`, role: 'assistant', content: reply, ts: Date.now(), engine: source });
  await dbm.saveNow();
  return { reply, engine: source, llm: engine };
}


/* ---------- Deterministic intents: identity, memory, website learning ---------- */
const CALL_ME_BLOCK = /^(later|tomorrow|now|soon|when|if|after|before|back|again|next|first|sometime|once)$/i;

async function routeIntent(msg) {
  const m = String(msg || '').trim();
  if (!m) return null;

  let mm = m.match(/^my name is\s+(.{2,60}?)\s*$/i);
  if (mm) return await setName(mm[1].replace(/[.!?]+$/, '').trim());
  mm = m.match(/^(?:please\s+)?call me\s+([a-z]+(?:[ -][a-z]+){0,2})\s*[.!?]*$/i);
  if (mm && !CALL_ME_BLOCK.test(mm[1].split(/[\s-]+/)[0].trim())) return await setName(mm[1].trim());

  if (/^(what(?:'s| is) my name|who am i|do you know (?:my name|who i am)|what do you know about me)\??$/i.test(m)) return identityReply();

  mm = m.match(/^(?:remember|note)(?:\s+that|\s+this)?\s+(.{3,2000})/i);
  if (mm) return await rememberReply(mm[1].trim());

  const urlMatch = m.match(/https?:\/\/[^\s"'<>\]]+/i);
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
  const m = msg.toLowerCase();
  const today = dayKey(Date.now(), tz);

  const eventsToday = db.find('events', e => dayKey(e.start, tz) === today).sort((a, b) => a.start - b.start);
  const upcoming = db.find('events', e => e.start > Date.now()).sort((a, b) => a.start - b.start).slice(0, 5);
  const openTasks = db.find('tasks', t => !t.done);
  const prioEmails = db.find('emails', e => e.priority === 'high');
  const unreadEmails = db.find('emails', e => !e.read);

  // Greeting / what's my day
  if (/\b(good morning|good afternoon|good evening|hey aria|hi aria|hello)\b/.test(m)) {
    const next = upcoming[0];
    return `**${greet()} ${cfg.owner.name}.** Here's where things stand:\n\n${summarizeDay(eventsToday, tz)}\n\n**Needs you now**\n${urgentItems(db, tz) || 'Nothing on fire. ✅'}\n\nAsk me about your schedule, priorities, inbox, or anything in your second brain.`;
  }
  if (/\b(day|schedule|calendar|meetings?|agenda|today look)\b/.test(m)) {
    return summarizeDay(eventsToday, tz) + (upcoming.length ? `\n\n**Coming up**\n${upcoming.map(e => `- ${dayKey(e.start, tz) === today ? 'today' : new Date(e.start).toDateString().slice(0, 3)} ${timeStr(e.start, tz)} — ${e.title}${e.location ? ` (${e.location})` : ''}`).join('\n')}` : '');
  }
  if (/\b(priorit\w*|focus|urgent\w*|important|first)\b/.test(m)) {
    const tasks = openTasks.slice(0, 5).map(t => `- 🔲 ${t.title}${t.due ? ` — due ${new Date(t.due).toLocaleDateString('en-GB', { timeZone: tz })}` : ''}`);
    return `**Top priorities right now**\n\n${urgentItems(db, tz) || '- No high-priority flags.'}\n\n**Action items**\n${tasks.join('\n') || '- None open.'}\n\n**Strategy:** ${focusAdvice(db)}`;
  }
  if (/\b(inbox|emails?|unread)\b/.test(m)) {
    const byCtx = { business: [], work: [] };
    for (const e of unreadEmails.slice(0, 10)) (byCtx[e.context || 'work'] = byCtx[e.context || 'work'] || []).push(e);
    const fmt = (list) => list.map(e => `- **${e.priority === 'high' ? '🔴' : e.priority === 'medium' ? '🟡' : '⚪'} ${e.subject}** — ${e.fromName || e.from} (${e.source})`).join('\n');
    return `**Unread inbox — ${unreadEmails.length} items**\n\n*Day job*\n${fmt(byCtx.work) || '- clear'}\n\n*Business*\n${fmt(byCtx.business) || '- clear'}\n\n${prioEmails.length ? `⚠️ ${prioEmails.length} flagged urgent — I suggest starting there.` : ''}`;
  }
  if (/\b(messages?|slack|whatsapp|chats?)\b/.test(m)) {
    const msgs = db.find('messages').sort((a, b) => b.sentAt - a.sentAt).slice(0, 8);
    return `**Latest across Slack & WhatsApp**\n\n${msgs.map(x => `- **${x.channel}** · ${x.from}: ${snippet(x.text, 110)}${x.priority === 'high' ? '  🔴' : ''}`).join('\n') || '- Nothing recent.'}`;
  }
  if (/\b(tasks?|todos?|action items?)\b/.test(m)) {
    return `**Open action items (${openTasks.length})**\n\n${openTasks.slice(0, 12).map(t => `- 🔲 ${t.title}${t.due ? ` — due ${new Date(t.due).toLocaleDateString('en-GB', { timeZone: tz })}` : ''}  _(${t.source})_`).join('\n') || '- All clear. Nothing open.'}`;
  }
  if (/\b(brain|know about|remember|notes?|knowledge|library)\b/.test(m)) {
    const q = msg.replace(/.*(?:know about|remember about|search(?: for)?|find)\s*/i, '').trim() || msg;
    const hits = brain.search(q, 5);
    if (!hits.length) return `Nothing in your second brain matches **"${q}"** yet.\n\nYou can teach me: paste anything into **Second Brain → Capture** and it becomes permanent memory. Everything from your briefs, priority emails and messages is already being captured automatically.`;
    return `**What your second brain knows about "${q}"**\n\n${hits.map(h => `- **${h.title}** _[${h.kind}]_\n  ${snippet(h.snippet, 160)}`).join('\n')}`;
  }
  if (/\b(brief|summary|summarize|summarise|recap|morning)\b/.test(m)) {
    const latest = db.find('briefs').sort((a, b) => b.generatedAt - a.generatedAt)[0];
    if (latest) return `${latest.markdown}\n\n---\n_Full archive lives under **Briefs**._`;
    return `No brief generated yet. Open the **Hub** and hit **Generate brief now** — or I'll have it ready every morning at ${cfg.wakeTime}.`;
  }
  if (/\b(business|side hustle|sales|orders?|suppliers?|mpesa|revenue)\b/.test(m)) {
    const bizEmails = db.find('emails', e => e.context === 'business').slice(0, 5);
    const bizMsgs = db.find('messages', x => x.context === 'business').slice(0, 5);
    const bizEvents = db.find('events', e => e.calendar === 'Business' && e.start > Date.now() - 864e5);
    return `**Business snapshot** 🏪\n\n*Upcoming business events*\n${bizEvents.map(e => `- ${dayKey(e.start, tz)} ${timeStr(e.start, tz)} — ${e.title}`).join('\n') || '- none' }\n\n*Business emails*\n${bizEmails.map(e => `- ${e.subject} — ${e.fromName}`).join('\n') || '- none'}\n\n*Business chats*\n${bizMsgs.map(x => `- [${x.channel}] ${x.from}: ${snippet(x.text, 80)}`).join('\n') || '- none'}`;
  }
  if (/\bhelp|what can you do|capabilit/.test(m)) {
    return `I'm ARIA — your executive assistant. Things you can ask me:\n\n- **"What does my day look like?"** — schedule across every calendar\n- **"What are my priorities?"** — ranked by urgency\n- **"How's my inbox?"** — unread, split day-job vs business\n- **"What's happening in Slack/WhatsApp?"**\n- **"What do I know about ___?"** — search your second brain\n- **"Show me the business picture"** — orders, suppliers, money\n\nI reason over your real data. ${engineStatus.activeEngine === 'ollama' ? `Running locally on Ollama (${engineStatus.model}) — fully private. 🟢` : 'Currently on the **built-in offline engine**. Install [Ollama](https://ollama.com), pull a model (e.g. `ollama pull llama3.1`), and I\'ll upgrade myself automatically in Settings → AI. 🔌'}`;
  }

  // Default: retrieval over the brain + honest fallback
  const hits = brain.search(msg, 5);
  const lines = [];
  if (hits.length) lines.push(`Here's the closest context I found for that:\n\n${hits.map(h => `- **${h.title}** _[${h.kind}]_\n  ${snippet(h.snippet, 160)}`).join('\n')}`);
  else lines.push(`I don't have context on that yet. Try asking about your **day**, **priorities**, **inbox**, **messages**, **business**, or your **second brain**.`);
  if (engineStatus.activeEngine !== 'ollama') lines.push(`\n_Tip: connect Ollama in **Settings → AI Engine** for full free-form reasoning — everything stays on your machine._`);
  return lines.join('\n');
}

function greet() { const h = +timeStr(Date.now(), 'Africa/Nairobi').split(':')[0]; return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

function summarizeDay(eventsToday, tz) {
  if (!eventsToday.length) return '**Today** — nothing on the calendar. A rare gift. 🌿';
  const now = minutesOfDay(Date.now(), tz);
  const lines = eventsToday.map(e => {
    const s = minutesOfDay(e.start, tz);
    const flag = s >= now && s < now + 60 ? ' 🔔 *soon*' : s < now ? ' ✓' : '';
    const icon = e.calendar === 'Business' ? '🏪' : e.calendar === 'Personal' ? '🏠' : '💼';
    return `- ${icon} **${timeStr(e.start, tz)}–${timeStr(e.end, tz)}** ${e.title}${e.location ? ` · ${e.location}` : ''}${flag}`;
  });
  const work = eventsToday.filter(e => e.calendar === 'Work').length;
  const biz = eventsToday.filter(e => e.calendar === 'Business').length;
  return `**Today — ${dayLabel(Date.now(), tz)}**\n\n${lines.join('\n')}\n\n_${work} day-job · ${biz} business commitment${biz === 1 ? '' : 's'}_`;
}

function urgentItems(db, tz) {
  const items = [];
  for (const e of db.find('emails', x => x.priority === 'high' && !x.read).slice(0, 3)) items.push(`- 🔴 **${e.subject}** — ${e.fromName || e.from} (${e.source})`);
  for (const ms of db.find('messages', x => x.priority === 'high' && !x.read).slice(0, 3)) items.push(`- 🔴 **${ms.channel}** — ${ms.from}: ${snippet(ms.text, 80)}`);
  return items.join('\n');
}

function focusAdvice(db) {
  const unreadBiz = db.find('emails', e => e.context === 'business' && !e.read).length;
  const unreadWork = db.find('emails', e => e.context !== 'business' && !e.read).length;
  const upcoming = db.find('events', e => e.start > Date.now()).sort((a, b) => a.start - b.start)[0];
  const bits = [];
  if (upcoming) bits.push(`next commitment is **${upcoming.title}** at ${timeStr(upcoming.start, 'Africa/Nairobi')}`);
  if (unreadBiz > unreadWork) bits.push('business is noisier than the day job today — clear supplier/customer chats first');
  else bits.push('day job is the louder channel this morning');
  return `${bits.join('; ')}.`;
}

module.exports = { respond, llmStatus };
