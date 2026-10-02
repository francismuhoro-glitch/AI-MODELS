'use strict';
/* Automation hub facade — extra tools + deterministic routing for alarms,
   reminders, messaging, media and routines. Sensitive sends never execute
   from the native tool loop without a user confirmation. */
const alarms = require('./alarms');
const messaging = require('./messaging');
const media = require('./media');
const phone = require('./phone');
const learning = require('./learning');
const permissions = require('./permissions');
const integrations = require('./integrations');
const cfgm = require('./config');
const dbm = require('./db');
const { dayKey, timeStr, dayLabel, zonedTime } = require('./util');

const TOOL_DEFS = [
  { name: 'create_alarm', description: 'Schedule a browser-notification alarm (NOT an OS device alarm). Confirm first when the time is ambiguous.', args: { title: { type: 'string', optional: true }, when: { type: 'natural language or ISO datetime' }, timezone: { type: 'IANA tz, default Africa/Nairobi', optional: true } } },
  { name: 'list_alarms', description: 'List active alarms.', args: { status: { type: '"active" | "scheduled" | "all"', optional: true } } },
  { name: 'snooze_alarm', description: 'Snooze an alarm by title or id.', args: { id: { type: 'alarm id or title' }, minutes: { type: 'number', optional: true } } },
  { name: 'cancel_alarm', description: 'Cancel an alarm by title or id.', args: { id: { type: 'alarm id or title' } } },
  { name: 'create_reminder', description: 'Create a reminder (distinct from a calendar event and from a device alarm).', args: { title: { type: 'string' }, when: { type: 'natural language or ISO datetime', optional: true } } },
  { name: 'list_reminders', description: 'List open/scheduled reminders.', args: { status: { type: 'string', optional: true } } },
  { name: 'draft_message', description: 'Draft a message without sending. Channel: whatsapp | telegram | sms | email.', args: { channel: { type: 'whatsapp | telegram | sms | email' }, to: { type: 'contact name, phone or email' }, body: { type: 'exact message text' } } },
  { name: 'send_message', description: 'Send a message. Always requires owner confirmation unless a matching automation rule exists. Never self-confirm.', args: { channel: { type: 'whatsapp | telegram | sms | email' }, to: { type: 'contact name, phone or email' }, body: { type: 'exact message text' }, draftId: { type: 'id of an existing draft', optional: true } } },
  { name: 'list_messages', description: 'List messages, optionally unread / for a day / channel.', args: { unread: { type: 'boolean', optional: true }, day: { type: 'today | tomorrow | YYYY-MM-DD', optional: true }, channel: { type: 'string', optional: true } } },
  { name: 'read_message', description: 'Read one message by id.', args: { id: { type: 'message id' } } },
  { name: 'mark_message_read', description: 'Mark a message as read.', args: { id: { type: 'message id' } } },
  { name: 'play_music', description: 'Request playback. Only local/browser media. Will not claim Spotify/Apple Music.', args: { query: { type: 'playlist or track name', optional: true }, source: { type: 'browser | local', optional: true } } },
  { name: 'pause_music', description: 'Pause browser/local media.', args: { source: { type: 'browser | local', optional: true } } },
  { name: 'resume_music', description: 'Resume browser/local media.', args: { source: { type: 'browser | local', optional: true } } },
  { name: 'skip_track', description: 'Skip if the browser can control the current media.', args: { source: { type: 'browser | local', optional: true } } },
  { name: 'set_volume', description: 'Set local/browser volume 0–100.', args: { level: { type: 'number 0-100' } } },
  { name: 'now_playing', description: 'Report last requested / client-confirmed playback. Never invent a track.', args: { provider: { type: 'string', optional: true } } },
  { name: 'search_free_slots', description: 'Show free slots on the calendar for a day.', args: { dayLabel: { type: 'today | tomorrow | weekday | YYYY-MM-DD', optional: true } } },
  { name: 'start_routine', description: 'Start a named local routine (default: morning). Messaging steps still require confirmation.', args: { name: { type: '"morning"', optional: true } } },
  { name: 'confirm_action', description: 'Confirm a pending sensitive action. Only the owner can do this — not the model.', args: { id: { type: 'confirmation id from the UI or chat' } } },
  { name: 'forget_memory', description: 'Forget a durable long-term memory: by id, or by topic (the memories that match by meaning). ALWAYS requires the owner to confirm — a model can never self-confirm a deletion.', args: { id: { type: 'memory id', optional: true }, query: { type: 'topic words, e.g. "supplier prices"', optional: true } } }
].concat(phone.TOOL_DEFS);

function str(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }

function freeSlotsText(dayText) {
  const { parseQueryDay } = require('./assistant');
  const cfg = cfgm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const rhythm = cfg.rhythm || { workStartHour: 8, workEndHour: 17 };
  const raw = String(dayText || 'tomorrow').trim() || 'tomorrow';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { key: raw, label: raw } : parseQueryDay(raw.toLowerCase(), tz);
  const db = dbm.load();
  const events = (db.events || []).filter((e) => e && dayKey(e.start, tz) === day.key).sort((a, b) => a.start - b.start);
  const workStart = zonedTime(day.key, rhythm.workStartHour || 8, 0, tz);
  const workEnd = zonedTime(day.key, rhythm.workEndHour || 17, 0, tz);
  const busy = events.map((e) => ({ start: e.start, end: e.end || e.start + 3600000, title: e.title }));
  const gaps = [];
  let cursor = workStart;
  for (const b of busy) {
    if (b.end <= workStart || b.start >= workEnd) continue;
    if (b.start > cursor + 10 * 60000) gaps.push({ start: cursor, end: Math.min(b.start, workEnd) });
    cursor = Math.max(cursor, b.end);
  }
  if (workEnd > cursor + 10 * 60000) gaps.push({ start: cursor, end: workEnd });
  const lines = gaps.map((g) => `- ${timeStr(g.start, tz)}–${timeStr(g.end, tz)}`);
  const evLines = events.map((e) => `- ${timeStr(e.start, tz)} ${e.title}`);
  return `**Free slots on ${day.label}** (${rhythm.workStartHour || 8}:00–${rhythm.workEndHour || 17}:00 ${tz}):\n${lines.join('\n') || '- none — the work window is full'}\n\n**Busy:**\n${evLines.join('\n') || '- nothing on the calendar'}\n\nThese are calendar gaps, not a new event. I have not created anything.`;
}

async function startRoutine(name) {
  const cfg = cfgm.load();
  const which = String(name || 'morning').toLowerCase() || 'morning';
  const routine = (cfg.routines && cfg.routines[which]) || (which === 'morning' ? { enabled: true, steps: ['calendar_today', 'unread_summary'] } : null);
  if (!routine || routine.enabled === false) {
    return { reply: `No "${which}" routine is configured. Set one in Settings.`, intent: 'routine' };
  }
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const steps = Array.isArray(routine.steps) ? routine.steps : ['calendar_today', 'unread_summary'];
  const bits = [`🌅 **${which} routine** — local steps only. Messaging is not sent automatically.`];
  for (const step of steps) {
    if (step === 'calendar_today') {
      const { calendarSummary } = require('./assistant');
      bits.push(calendarSummary('today'));
    } else if (step === 'unread_summary') {
      const db = dbm.load();
      const unreadE = (db.emails || []).filter((e) => !e.read).length;
      const unreadM = (db.messages || []).filter((m) => !m.read).length;
      bits.push(`Inbox: ${unreadE} unread email${unreadE === 1 ? '' : 's'}, ${unreadM} unread message${unreadM === 1 ? '' : 's'}.`);
    } else if (step === 'play_focus') {
      const played = await media.play({ query: 'focus playlist', source: 'local' });
      bits.push(played.reply);
    } else if (step === 'next_alarm') {
      const next = alarms.list({ kind: 'alarm' })[0];
      bits.push(next ? `Next alarm: ${next.title} at ${timeStr(next.fireAt, next.timezone || tz)} (browser notification, not a device alarm).` : 'No alarms scheduled.');
    }
  }
  permissions.audit({ integration: 'routines', action: 'start', status: 'ok', summary: which });
  return { reply: bits.join('\n\n'), intent: 'routine' };
}

async function confirmPending(id, { origin } = {}) {
  const got = permissions.consume(id, { origin });
  if (!got.ok) return { reply: got.error, intent: 'confirm', confirmed: false };
  const rec = got.rec;
  const payload = rec.payload || {};
  if (payload.type === 'send' || rec.action === 'send') {
    const draft = messaging.getDraft(payload.draftId);
    if (!draft) return { reply: 'The draft disappeared — nothing was sent.', intent: 'confirm', confirmed: false };
    const result = await messaging.performSend(draft, { idempotencyKey: payload.idempotencyKey });
    return { ...result, intent: 'message-send', confirmed: !!result.sent };
  }
  /* Owner confirmed a memory deletion the model proposed. Only this path (origin 'user') runs it. */
  if (payload.type === 'forget') {
    const result = await learning.forget({ mode: payload.ids && payload.ids.length ? 'ids' : 'topic', query: payload.query || '', ids: payload.ids });
    return { reply: result.reply, intent: 'memory-forget', removed: result.removed, confirmed: result.removed > 0 };
  }
  /* Owner confirmed a REAL phone command the model asked for (phone alarm / media / app).
     Only this path (origin 'user') can push it into the outbox. */
  if (payload.type === 'phone' || /^phone_/.test(String(rec.action || ''))) {
    const result = await phone.enqueue({
      type: payload.command || String(rec.action || '').replace(/^phone_/, ''),
      args: payload.args || {},
      idempotencyKey: payload.idempotencyKey,
      origin: 'user'
    });
    return { ...result, intent: result.intent || 'phone-command', confirmed: !!result.queued };
  }
  if (payload.kind === 'alarm' || payload.kind === 'reminder' || rec.action === 'create_alarm' || rec.action === 'create_reminder') {
    const result = await alarms.create({
      kind: payload.kind || (rec.action === 'create_reminder' ? 'reminder' : 'alarm'),
      title: payload.title,
      body: payload.body,
      when: payload.when,
      fireAt: payload.fireAt,
      timezone: payload.timezone,
      recurrence: payload.recurrence,
      source: payload.source || 'assistant',
      confirmIfAmbiguous: false,
      origin: 'user'
    });
    return { ...result, intent: result.intent, confirmed: !!result.created };
  }
  return { reply: 'That confirmation had nothing attached. Nothing ran.', intent: 'confirm', confirmed: false };
}

async function executeTool(name, args, origin = 'assistant') {
  const tool = String(name || '').trim();
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  try {
    switch (tool) {
      case 'create_alarm': {
        const when = str(a.when || a.startISO || a.time || a.at);
        if (!when && !a.fireAt) return null;
        return await alarms.create({
          kind: 'alarm',
          title: str(a.title || a.name) || 'Alarm',
          when,
          fireAt: a.fireAt,
          timezone: str(a.timezone) || undefined,
          source: origin === 'tool-loop' ? 'assistant-tool' : 'assistant',
          origin
        });
      }
      case 'list_alarms': {
        const items = alarms.list({ kind: 'alarm', status: str(a.status) || 'active' }).map(alarms.publicItem);
        return { reply: items.length ? '**Active alarms** (browser notifications, not device alarms):\n' + alarms.formatList(items) : 'No active alarms.', intent: 'alarm-list', alarms: items };
      }
      case 'snooze_alarm': {
        const id = str(a.id || a.title || a.what);
        if (!id) return null;
        return await alarms.snooze(id, a.minutes, 'alarm');
      }
      case 'cancel_alarm': {
        const id = str(a.id || a.title || a.what);
        if (!id) return null;
        return await alarms.cancel(id, 'alarm');
      }
      case 'create_reminder': {
        const title = str(a.title || a.what || a.body);
        if (!title) return null;
        return await alarms.create({
          kind: 'reminder',
          title,
          body: str(a.body) || title,
          when: str(a.when || a.startISO || a.at),
          timezone: str(a.timezone) || undefined,
          source: origin === 'tool-loop' ? 'assistant-tool' : 'assistant',
          origin
        });
      }
      case 'list_reminders': {
        const items = alarms.list({ kind: 'reminder', status: str(a.status) || 'active' }).map(alarms.publicItem);
        return { reply: items.length ? '**Reminders:**\n' + alarms.formatList(items) : 'No open reminders.', intent: 'reminder-list', reminders: items };
      }
      case 'draft_message': {
        const channel = str(a.channel || a.app).toLowerCase();
        const to = str(a.to || a.recipient || a.who);
        const body = str(a.body || a.message || a.text);
        if (!channel || !to || !body) return null;
        return await messaging.draftMessage({ channel, to, body, subject: str(a.subject), source: origin === 'tool-loop' ? 'assistant-tool' : 'assistant' });
      }
      case 'send_message': {
        const channel = str(a.channel || a.app).toLowerCase();
        const to = str(a.to || a.recipient || a.who);
        const body = str(a.body || a.message || a.text);
        if (!a.draftId && (!channel || !to || !body)) return null;
        return await messaging.sendMessage({
          channel, to, body, subject: str(a.subject), draftId: str(a.draftId) || undefined,
          idempotencyKey: str(a.idempotencyKey) || undefined,
          source: origin === 'tool-loop' ? 'assistant-tool' : 'assistant',
          origin,
          confirmed: a.confirmed === true
        });
      }
      case 'list_messages': {
        const items = messaging.listMessages({
          unread: a.unread === true || String(a.unread).toLowerCase() === 'true',
          day: str(a.day || a.when) || undefined,
          channel: str(a.channel) || undefined,
          query: str(a.query) || undefined
        });
        const cfg = cfgm.load();
        const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
        return { reply: messaging.formatMessages(items, tz), intent: 'message-list', messages: items };
      }
      case 'read_message': {
        const id = str(a.id);
        if (!id) return null;
        return messaging.readMessage(id);
      }
      case 'mark_message_read': {
        const id = str(a.id);
        if (!id) return null;
        return await messaging.markRead(id);
      }
      case 'play_music':
        return await media.play({ query: str(a.query || a.title || a.playlist), source: str(a.source) });
      case 'pause_music':
        return media.pause();
      case 'resume_music':
        return media.resume();
      case 'skip_track':
        return media.skip();
      case 'set_volume': {
        if (a.level === undefined && a.volume === undefined && a.value === undefined) return null;
        return media.setVolume(a.level !== undefined ? a.level : (a.volume !== undefined ? a.volume : a.value));
      }
      case 'now_playing':
        return media.nowPlaying();
      case 'search_free_slots':
        return { reply: freeSlotsText(str(a.dayLabel || a.day || a.when) || 'tomorrow'), intent: 'schedule-query' };
      case 'start_routine':
        return await startRoutine(str(a.name || a.which) || 'morning');
      case 'forget_memory': {
        const id = str(a.id || a.memoryId);
        const query = str(a.query || a.about || a.topic || a.content);
        if (!id && !query) return null;
        if (origin === 'tool-loop') {
          const rec = permissions.createConfirmation({
            action: 'forget_memory',
            integration: 'memory',
            preview: {
              title: 'Forget a memory',
              kind: 'memory',
              destination: '',
              body: id ? `memory ${id}` : `memories matching "${query}"`
            },
            payload: { type: 'forget', ids: id ? [id] : [], query }
          });
          return {
            reply: `That would delete ${id ? 'a stored memory' : `memories matching "${query}"`}. A model cannot confirm a deletion — say **confirm** or tap Confirm and I will remove it. Nothing was deleted yet.`,
            intent: 'memory-forget',
            needsConfirmation: true,
            confirmation: permissions.publicConfirmation(rec)
          };
        }
        const result = await learning.forget({ mode: id ? 'ids' : 'topic', ids: id ? [id] : [], query });
        return { reply: result.reply, intent: 'memory-forget', removed: result.removed };
      }
      case 'confirm_action': {
        if (origin === 'tool-loop') {
          return { reply: 'A model cannot confirm a sensitive action. The owner must say confirm or tap Confirm.', intent: 'confirm', confirmed: false };
        }
        const id = str(a.id || a.token);
        if (!id) return null;
        return await confirmPending(id, { origin });
      }
      default: {
        /* Android phone bridge commands (phone_command) — real device alarm / media / app. */
        const viaPhone = await phone.executeTool(tool, a, origin);
        if (viaPhone) return viaPhone;
        return null;
      }
    }
  } catch (e) {
    return { reply: 'That action failed: ' + require('./secrets').safeError(e), intent: 'error' };
  }
}

function parseMessageIntent(sm) {
  const s = String(sm || '').trim();
  const isDraft = /^(?:draft|write)\b/i.test(s);
  const isSend = /^(?:send|text)\b/i.test(s) && !isDraft;
  let channel = null;
  if (/\bwhatsapp\b/i.test(s)) channel = 'whatsapp';
  else if (/\btelegram\b/i.test(s)) channel = 'telegram';
  else if (/\b(?:sms|text message)\b/i.test(s) || (/\bsms\b/i.test(s))) channel = 'sms';
  else if (/\bemail\b/i.test(s)) channel = 'email';
  if (!channel) return null;
  if (!isDraft && !isSend && !/^(?:draft|send|text)\b/i.test(s)) return null;
  const saying = s.match(/\b(?:saying|that says|that|:)\s+(.+)$/i);
  const body = saying ? saying[1].replace(/^["“']|["”']$/g, '').trim() : '';
  let to = '';
  const sendName = s.match(/^send\s+([A-Za-z][\w'’-]+)\s+a\s+/i);
  const toM = s.match(/\bto\s+([A-Za-z][\w .'’-]+?)(?:\s+(?:saying|that|a\s+|an\s+)|$)/i);
  if (sendName) to = sendName[1].trim();
  else if (toM) to = toM[1].trim();
  return { draft: isDraft || !isSend, channel, to, body, raw: s };
}

function matchAlarm(sm) {
  const s = String(sm || '').trim();
  if (/\b(set|create|add|make)\s+(?:me\s+)?(?:an?\s+)?alarm\b/i.test(s) || /\bwake\s+me(?:\s+up)?\b/i.test(s)) return { action: 'create', text: s };
  if (/\b(cancel|delete|remove)\s+(?:the\s+|my\s+)?alarm\b/i.test(s)) return { action: 'cancel', text: s };
  if (/\bsnooze\b/i.test(s) && /\balarm\b/i.test(s)) return { action: 'snooze', text: s };
  if (/\b(?:list|show|what(?:'s| is)|which)\b.*\balarms?\b/i.test(s) || /\balarms?\b.*\b(?:list|active|set)\b/i.test(s)) return { action: 'list', text: s };
  return null;
}

function matchReminder(sm) {
  const s = String(sm || '').trim();
  if (/^remind\s+me\b/i.test(s) || /\b(add|create|set|make)\s+(?:a\s+|an\s+)?reminder\b/i.test(s)) return { text: s };
  return null;
}

function reminderHasWhen(text) {
  return alarms.hasClock(text) || /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|after)\b/i.test(text);
}

function reminderTitle(text) {
  return String(text || '')
    .replace(/^(?:remind\s+me(?:\s+to)?|(?:add|create|set|make)\s+(?:a\s+|an\s+)?reminder(?:\s+to)?)\s+/i, '')
    .replace(/\b(?:at|on|for|tomorrow|today|tonight|nairobi time|africa\/nairobi)\b.*$/i, '')
    .replace(/\bafter\s+(?:the\s+)?.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Reminder';
}

async function route(msg) {
  const s = String(msg || '').trim();
  if (!s) return null;

  const pending = permissions.latestPending();
  if (pending && permissions.isExplicitUserConfirm(s)) {
    return await confirmPending(pending.id, { origin: 'user' });
  }
  if (pending && permissions.isExplicitUserCancel(s)) {
    permissions.cancel(pending.id);
    return { reply: 'Cancelled — nothing was sent or changed.', intent: 'confirm-cancel' };
  }

  /* Android phone bridge — "set an alarm on my phone for 6:30", "pause the music on my phone".
     Runs BEFORE the browser alarm / browser media matchers so a phone request is never turned
     into a browser notification or a tab-local playback action. */
  try {
    const ph = await phone.route(s, { origin: 'user' });
    if (ph && ph.reply) return ph;
  } catch (_) {}

  const al = matchAlarm(s);
  if (al) {
    if (al.action === 'create') {
      return await alarms.create({ kind: 'alarm', title: 'Alarm', when: al.text, source: 'assistant', origin: 'user' });
    }
    if (al.action === 'list') {
      const items = alarms.list({ kind: 'alarm' }).map(alarms.publicItem);
      return { reply: items.length ? '**Active alarms** (browser notifications, not device alarms):\n' + alarms.formatList(items) : 'No active alarms.', intent: 'alarm-list' };
    }
    if (al.action === 'cancel') {
      const what = s.replace(/^(?:cancel|delete|remove)\s+(?:the\s+|my\s+)?alarm\s*(?:for|called|named)?\s*/i, '').trim() || 'Alarm';
      return await alarms.cancel(what, 'alarm');
    }
    if (al.action === 'snooze') {
      const mins = (s.match(/(\d+)\s*min/i) || [])[1];
      return await alarms.snooze('Alarm', mins, 'alarm');
    }
  }

  const rem = matchReminder(s);
  if (rem && reminderHasWhen(rem.text)) {
    return await alarms.create({
      kind: 'reminder',
      title: reminderTitle(rem.text),
      body: reminderTitle(rem.text),
      when: rem.text,
      source: 'assistant',
      origin: 'user'
    });
  }
  if (rem && /\b(add|create|set|make)\s+(?:a\s+|an\s+)?reminder\b/i.test(s)) {
    return await alarms.create({
      kind: 'reminder',
      title: reminderTitle(s),
      body: reminderTitle(s),
      when: '',
      source: 'assistant',
      origin: 'user',
      confirmIfAmbiguous: false
    });
  }

  if (/\b(unread messages|messages from today|read (?:my )?(?:unread )?messages)\b/i.test(s) && !/\bemail/i.test(s)) {
    const day = /\btoday\b/i.test(s) ? 'today' : (/\btomorrow\b/i.test(s) ? 'tomorrow' : undefined);
    const items = messaging.listMessages({ unread: /unread/i.test(s) || !day, day });
    return { reply: '**Messages:**\n' + messaging.formatMessages(items), intent: 'message-list' };
  }

  const mi = parseMessageIntent(s);
  if (mi && mi.to && mi.body) {
    if (mi.draft) return await messaging.draftMessage({ channel: mi.channel, to: mi.to, body: mi.body, source: 'assistant' });
    return await messaging.sendMessage({ channel: mi.channel, to: mi.to, body: mi.body, source: 'assistant', origin: 'user' });
  }

  if (/^(?:pause(?:\s+the)?\s+music)\b/i.test(s) || /\bpause\s+(?:the\s+)?(?:music|track|song)\b/i.test(s)) return media.pause();
  if (/\b(resume|continue|unpause)\b.*\b(music|track|song)\b/i.test(s)) return media.resume();
  if (/\b(skip|next)\b.*\b(track|song|music)\b/i.test(s)) return media.skip();
  if (/\bnow playing\b|\bwhat(?:'s| is) playing\b/i.test(s)) return media.nowPlaying();
  if (/\bvolume\b/i.test(s) && /\b(\d{1,3})\b/.test(s)) return media.setVolume(s.match(/\b(\d{1,3})\b/)[1]);
  if (/^play\s+my\s+/i.test(s) || /\bplay\b.*\b(music|playlist|song|track|focus)\b/i.test(s)) {
    return await media.play({ query: s.replace(/^(?:play(?:\s+me)?)\s+/i, '').trim() });
  }

  if (/\b(start|begin|run)\s+(?:my\s+)?morning\s+routine\b/i.test(s)) return await startRoutine('morning');

  if (/\b(free slots?|availability|when am i free|open (?:the )?calendar)\b/i.test(s)) {
    const day = /\btomorrow\b/i.test(s) ? 'tomorrow' : (/\btoday\b/i.test(s) ? 'today' : 'tomorrow');
    return { reply: freeSlotsText(day), intent: 'schedule-query' };
  }

  return null;
}

function toolResultForModel(result) {
  if (!result) return result;
  const out = { reply: result.reply || '' };
  if (result.event) out.event = { id: result.event.id, title: result.event.title, start: result.event.start };
  if (result.task) out.task = { id: result.task.id, title: result.task.title };
  if (result.needsConfirmation) {
    out.needsConfirmation = true;
    out.preview = result.confirmation ? result.confirmation.preview : null;
  }
  if (result.sent === false) out.sent = false;
  if (result.created === false) out.created = false;
  if (result.ok === false) out.ok = false;
  if (result.deviceAlarm) out.deviceAlarm = result.deviceAlarm;
  if (typeof result.removed === 'number') out.removed = result.removed;
  if (result.confirmedPlayback === false) out.confirmedPlayback = false;
  return out;
}

module.exports = {
  TOOL_DEFS, executeTool, route, confirmPending, freeSlotsText, startRoutine,
  parseMessageIntent, matchAlarm, matchReminder, toolResultForModel
};
