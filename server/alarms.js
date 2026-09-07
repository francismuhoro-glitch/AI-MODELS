'use strict';
/* ARIA alarm / reminder abstraction.
   Kinds we NEVER confuse:
     calendar event  — db.events (meetings)
     reminder        — db.reminders (to-do with optional fire time)
     browser notification / web push — delivery of an alarm or reminder
     actual device alarm — OS clock alarm. Web apps cannot create one.
   We never claim a device alarm was created. Delivery is browser notification
   plus optional web-push fallback when the tab is closed. */
const dbm = require('./db');
const cfgm = require('./config');
const permissions = require('./permissions');
const { uid, dayKey, dayKeyAdd, dayKeyDow, zonedTime, timeStr, dayLabel } = require('./util');

const ACTIVE = new Set(['scheduled', 'snoozed', 'open']);
const DEVICE_ALARM = {
  claimed: false,
  status: 'unavailable',
  reason: 'Web browsers and PWAs cannot create an OS device alarm. ARIA schedules a browser notification (and web push if enabled) instead.'
};

function tzOf(explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const cfg = cfgm.load();
  return (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
}

function resolveTz(text, fallback) {
  const t = String(text || '');
  if (/nairobi|africa\/nairobi|\beat\b/i.test(t)) return 'Africa/Nairobi';
  return tzOf(fallback);
}

function stripTzPhrases(text) {
  return String(text || '')
    .replace(/\s*(?:in\s+)?(?:nairobi(?:\s+time)?|africa\/nairobi|\beat\b|local time)\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function hasClock(text) {
  const t = String(text || '').toLowerCase();
  return /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/.test(t)
    || /\bnoon\b|\bmidnight\b/.test(t)
    || /\bin\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/.test(t);
}

function isAmbiguousWhen(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return true;
  if (/\b(this time|later|soon|sometime|whenever|after a while)\b/.test(t)) return true;
  if (/\bafter\s+(?:the\s+)?[a-z]/.test(t) && !hasClock(t)) return true;
  if (!hasClock(t)) return true;
  return false;
}

function parseRecurrence(text) {
  const t = String(text || '').toLowerCase();
  if (/\bevery\s+day\b|\bdaily\b/.test(t)) return { freq: 'daily' };
  if (/\bweekdays?\b|\bevery\s+weekday\b/.test(t)) return { freq: 'weekdays' };
  const wd = t.match(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) return { freq: 'weekly', weekday: wd[1] };
  return null;
}

function parseRelativeMs(text, timezone) {
  const t = String(text || '').toLowerCase();
  const rel = t.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms = /hour|hr/.test(unit) ? n * 3600000 : n * 60000;
    return Date.now() + ms;
  }
  const { parseRelativeDateTime } = require('./assistant');
  const cleaned = stripTzPhrases(t)
    .replace(/\bthis time\b/g, '')
    .replace(/\b(set|create|add|make)\s+(?:me\s+)?(?:an?\s+)?(alarm|reminder)\b/gi, '')
    .replace(/\b(wake me(?:\s+up)?)\b/gi, '')
    .replace(/\bremind me(?:\s+to)?\b/gi, '')
    .replace(/\bfor\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  /* "tomorrow at this time" → same wall-clock tomorrow. */
  if (/\btomorrow\b/.test(t) && /\bthis time\b/.test(t) && !/\d/.test(t.replace(/tomorrow/g, ''))) {
    const tz = timezone;
    const nowKey = dayKey(Date.now(), tz);
    const parts = require('./util').tzDate(Date.now(), tz);
    return zonedTime(dayKeyAdd(nowKey, 1), +parts.hour, +parts.minute, tz);
  }
  const phrase = cleaned || t;
  const ts = parseRelativeDateTime(phrase, timezone);
  return Number.isFinite(ts) ? ts : null;
}

function parseWhen(text, timezone) {
  const tz = resolveTz(text, timezone);
  const fireAt = parseRelativeMs(text, tz);
  return {
    fireAt,
    timezone: tz,
    ambiguous: isAmbiguousWhen(text),
    recurrence: parseRecurrence(text),
    label: fireAt ? `${dayLabel(fireAt, tz)} at ${timeStr(fireAt, tz)} (${tz})` : null
  };
}

function col(name) {
  const db = dbm.load();
  if (!Array.isArray(db[name])) db[name] = [];
  return db[name];
}

function deliveryHint(pushLikely) {
  const bits = [
    'This is a **browser notification**, not a calendar event and not an OS device alarm.'
  ];
  if (!pushLikely) {
    bits.push('If this tab is closed I may miss it — enable lock-screen notifications in Settings for a web-push fallback.');
  } else {
    bits.push('If this tab is closed I will try web push (lock-screen), still not a device alarm.');
  }
  return bits.join(' ');
}

function pushLikely() {
  const db = dbm.load();
  return Array.isArray(db.subscriptions) && db.subscriptions.length > 0;
}

function shapeAlarm(input, kind) {
  const cfgTz = tzOf(input.timezone);
  const parsed = input.fireAt ? {
    fireAt: Number(input.fireAt),
    timezone: cfgTz,
    ambiguous: false,
    recurrence: input.recurrence || null,
    label: `${dayLabel(input.fireAt, cfgTz)} at ${timeStr(input.fireAt, cfgTz)} (${cfgTz})`
  } : parseWhen(input.when || input.text || '', cfgTz);
  return { parsed, kind };
}

function recordOf(kind, fields) {
  const now = Date.now();
  return {
    id: fields.id || uid(kind === 'reminder' ? 'rem' : 'alarm'),
    kind,
    title: String(fields.title || (kind === 'reminder' ? 'Reminder' : 'Alarm')).slice(0, 160),
    body: String(fields.body || '').slice(0, 2000),
    fireAt: fields.fireAt || null,
    timezone: fields.timezone || tzOf(),
    recurrence: fields.recurrence || null,
    snoozeMinutes: Number(fields.snoozeMinutes) > 0 ? Number(fields.snoozeMinutes) : 10,
    status: fields.fireAt ? 'scheduled' : 'open',
    snoozeUntil: null,
    lastFiredAt: null,
    trigger: fields.trigger || null,
    source: fields.source || 'api',
    createdAt: now,
    updatedAt: now,
    deviceAlarm: { ...DEVICE_ALARM },
    delivery: {
      browserNotification: true,
      webPush: true,
      inApp: true,
      deviceAlarm: false
    },
    deliveryResult: null
  };
}

function findIn(name, idOrTitle) {
  const q = String(idOrTitle || '').trim().toLowerCase();
  if (!q) return null;
  const list = col(name);
  return list.find((a) => a && a.id === idOrTitle)
    || list.find((a) => a && ACTIVE.has(a.status) && String(a.title || '').toLowerCase() === q)
    || list.find((a) => a && ACTIVE.has(a.status) && String(a.title || '').toLowerCase().includes(q))
    || null;
}

function findNextMeeting(query) {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const now = Date.now();
  const words = String(query || 'meeting').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^(the|and|for|with|my|our|after)$/i.test(w));
  const upcoming = (db.events || []).filter((e) => e && e.start >= now - 60 * 60000).sort((a, b) => a.start - b.start);
  const hits = words.length
    ? upcoming.filter((e) => words.every((w) => String(e.title || '').toLowerCase().includes(w)) || words.some((w) => String(e.title || '').toLowerCase().includes(w)))
    : upcoming.filter((e) => /meeting|call|sync|standup/i.test(e.title || ''));
  return { tz, hits, upcoming };
}

function afterMeetingTrigger(text) {
  const m = String(text || '').match(/\bafter\s+(?:the\s+|my\s+)?(.+?)(?:[.!?]|\\s*$)/i);
  return m ? m[1].trim() : 'meeting';
}

async function create({ kind = 'alarm', title, body, when, fireAt, timezone, recurrence, source, confirmIfAmbiguous = true, origin }) {
  const k = kind === 'reminder' ? 'reminder' : 'alarm';
  const collection = k === 'reminder' ? 'reminders' : 'alarms';
  const tz = resolveTz(when, timezone);
  let trigger = null;
  let parsed = fireAt ? {
    fireAt: Number(fireAt), timezone: tz, ambiguous: false,
    recurrence: recurrence || parseRecurrence(when || ''),
    label: `${dayLabel(fireAt, tz)} at ${timeStr(fireAt, tz)} (${tz})`
  } : parseWhen(when || '', tz);

  if ((!parsed.fireAt || parsed.ambiguous) && /\bafter\s+(?:the\s+)?/i.test(String(when || ''))) {
    const q = afterMeetingTrigger(when);
    const found = findNextMeeting(q);
    if (found.hits.length === 1) {
      const ev = found.hits[0];
      parsed = {
        fireAt: ev.end || ev.start + 3600000,
        timezone: found.tz,
        ambiguous: true,
        recurrence: null,
        label: `after "${ev.title}" (${dayLabel(ev.end || ev.start, found.tz)} ${timeStr(ev.end || ev.start, found.tz)})`
      };
      trigger = { type: 'after_event', eventId: ev.id, query: q };
    } else if (found.hits.length > 1) {
      const rec = permissions.createConfirmation({
        action: 'create_' + k,
        integration: k === 'reminder' ? 'reminders' : 'alarms',
        preview: {
          title: title || (k === 'reminder' ? 'Reminder' : 'Alarm'),
          kind: k,
          whenLabel: 'ambiguous — several matching events',
          body: found.hits.slice(0, 4).map((e) => e.title).join(', ')
        },
        payload: { kind: k, title, body, when, timezone: tz, source, origin: 'confirm' }
      });
      return {
        reply: `I found more than one matching event (${found.hits.slice(0, 3).map((e) => `"${e.title}"`).join(', ')}). Tell me which one, or give a clock time. Nothing was created yet.`,
        intent: k === 'reminder' ? 'reminder-confirm' : 'alarm-confirm',
        needsConfirmation: true,
        confirmation: permissions.publicConfirmation(rec),
        created: false
      };
    }
  }

  if (confirmIfAmbiguous && parsed.ambiguous) {
    const rec = permissions.createConfirmation({
      action: 'create_' + k,
      integration: k === 'reminder' ? 'reminders' : 'alarms',
      preview: {
        title: title || (k === 'reminder' ? 'Reminder' : 'Alarm'),
        kind: k,
        whenLabel: parsed.label || 'time not resolved',
        body: body || ''
      },
      payload: {
        kind: k, title, body, when, fireAt: parsed.fireAt, timezone: parsed.timezone,
        recurrence: parsed.recurrence, source, origin: 'confirm'
      }
    });
    const whenBit = parsed.label
      ? `I would schedule it for **${parsed.label}**.`
      : 'I could not resolve a clock time.';
    return {
      reply: `Before I create this ${k}: ${whenBit} ${deliveryHint(pushLikely())} Say **confirm** to create it, or give me an exact time (e.g. "tomorrow at 7:00 AM Nairobi time").`,
      intent: k === 'reminder' ? 'reminder-confirm' : 'alarm-confirm',
      needsConfirmation: true,
      confirmation: permissions.publicConfirmation(rec),
      resolved: parsed,
      created: false
    };
  }

  if (!parsed.fireAt && k === 'alarm') {
    return {
      reply: 'I need a time for the alarm (for example "tomorrow at 7:00 AM Nairobi time"). Nothing was created.',
      intent: 'alarm-confirm',
      created: false
    };
  }

  const item = recordOf(k, {
    title: title || (k === 'reminder' ? (body || 'Reminder') : 'Alarm'),
    body: body || '',
    fireAt: parsed.fireAt,
    timezone: parsed.timezone,
    recurrence: recurrence || parsed.recurrence,
    trigger,
    source: source || 'assistant'
  });
  col(collection).unshift(item);
  await dbm.saveNow();
  permissions.audit({
    integration: collection,
    action: 'create',
    status: 'ok',
    summary: `${k} "${item.title}" ${item.fireAt ? 'at ' + parsed.label : '(in-app)'}`,
    target: item.id
  });
  const whenBit = item.fireAt
    ? `for **${dayLabel(item.fireAt, item.timezone)} at ${timeStr(item.fireAt, item.timezone)}** (${item.timezone})`
    : 'as an in-app reminder (no fire time)';
  return {
    reply: `⏰ **${k === 'reminder' ? 'Reminder' : 'Alarm'} set** "${item.title}" ${whenBit}. ${deliveryHint(pushLikely())}`,
    intent: k === 'reminder' ? 'reminder-create' : 'alarm-create',
    [k]: item,
    created: true,
    deviceAlarm: { ...DEVICE_ALARM }
  };
}

function list({ kind, status } = {}) {
  const want = kind === 'reminder' ? 'reminders' : kind === 'alarm' ? 'alarms' : null;
  const names = want ? [want] : ['alarms', 'reminders'];
  const st = status ? String(status) : 'active';
  const out = [];
  for (const n of names) {
    for (const a of col(n)) {
      if (!a) continue;
      if (st === 'active' && !ACTIVE.has(a.status)) continue;
      if (st !== 'active' && st !== 'all' && a.status !== st) continue;
      out.push(a);
    }
  }
  out.sort((a, b) => (a.fireAt || a.createdAt || 0) - (b.fireAt || b.createdAt || 0));
  return out;
}

function formatList(items, tz) {
  if (!items.length) return 'No active alarms or reminders.';
  return items.map((a) => {
    const when = a.fireAt ? `${dayLabel(a.fireAt, a.timezone || tz)} ${timeStr(a.fireAt, a.timezone || tz)}` : 'no fire time';
    return `- **${a.title}** _[${a.kind} · ${a.status}]_ ${when}`;
  }).join('\n');
}

async function cancel(idOrTitle, kind) {
  const names = kind === 'reminder' ? ['reminders'] : kind === 'alarm' ? ['alarms'] : ['alarms', 'reminders'];
  let item = null;
  let coll = null;
  for (const n of names) {
    item = findIn(n, idOrTitle);
    if (item) { coll = n; break; }
  }
  if (!item) return { reply: `I could not find an active alarm or reminder matching "${idOrTitle}".`, cancelled: false };
  item.status = 'cancelled';
  item.updatedAt = Date.now();
  await dbm.saveNow();
  permissions.audit({ integration: coll, action: 'cancel', status: 'ok', summary: `cancelled "${item.title}"`, target: item.id });
  return { reply: `Cancelled **${item.title}** (${item.kind}).`, cancelled: true, item };
}

async function snooze(idOrTitle, minutes, kind) {
  const names = kind === 'reminder' ? ['reminders'] : kind === 'alarm' ? ['alarms'] : ['alarms', 'reminders'];
  let item = null;
  for (const n of names) { item = findIn(n, idOrTitle); if (item) break; }
  if (!item) return { reply: `I could not find an alarm or reminder matching "${idOrTitle}" to snooze.`, snoozed: false };
  const mins = Number(minutes) > 0 ? Number(minutes) : (item.snoozeMinutes || 10);
  const base = item.status === 'fired' ? Date.now() : (item.snoozeUntil || item.fireAt || Date.now());
  item.snoozeUntil = base + mins * 60000;
  item.status = 'snoozed';
  item.updatedAt = Date.now();
  await dbm.saveNow();
  permissions.audit({ integration: item.kind === 'reminder' ? 'reminders' : 'alarms', action: 'snooze', status: 'ok', summary: `snoozed "${item.title}" ${mins}m`, target: item.id });
  return {
    reply: `Snoozed **${item.title}** for ${mins} minutes (browser notification, not a device alarm).`,
    snoozed: true,
    item
  };
}

function due(now = Date.now()) {
  const out = [];
  for (const n of ['alarms', 'reminders']) {
    for (const a of col(n)) {
      if (!a) continue;
      if (a.status === 'scheduled' && a.fireAt && a.fireAt <= now) out.push(a);
      if (a.status === 'snoozed' && a.snoozeUntil && a.snoozeUntil <= now) out.push(a);
    }
  }
  return out;
}

function nextFire(fromMs, rec, timezone) {
  if (!rec) return null;
  const tz = timezone || tzOf();
  const key = dayKey(fromMs, tz);
  if (rec.freq === 'daily') {
    const p = require('./util').tzDate(fromMs, tz);
    return zonedTime(dayKeyAdd(key, 1), +p.hour, +p.minute, tz);
  }
  if (rec.freq === 'weekdays') {
    let k = dayKeyAdd(key, 1);
    for (let i = 0; i < 8; i++) {
      const dow = dayKeyDow(k);
      if (dow !== 0 && dow !== 6) {
        const p = require('./util').tzDate(fromMs, tz);
        return zonedTime(k, +p.hour, +p.minute, tz);
      }
      k = dayKeyAdd(k, 1);
    }
  }
  if (rec.freq === 'weekly') {
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const want = days[String(rec.weekday || '').toLowerCase()];
    let k = dayKeyAdd(key, 1);
    for (let i = 0; i < 8; i++) {
      if (dayKeyDow(k) === want) {
        const p = require('./util').tzDate(fromMs, tz);
        return zonedTime(k, +p.hour, +p.minute, tz);
      }
      k = dayKeyAdd(k, 1);
    }
  }
  return null;
}

async function markFired(id, delivery) {
  let item = findIn('alarms', id) || findIn('reminders', id);
  if (!item) return null;
  if (item.status === 'cancelled') return item;
  const wasActive = item.status === 'scheduled' || item.status === 'snoozed';
  if (wasActive) {
    item.status = 'fired';
    item.lastFiredAt = Date.now();
    item.updatedAt = Date.now();
    item.deliveryResult = {
      ...(item.deliveryResult || {}),
      ...(delivery || {}),
      deviceAlarm: { ...DEVICE_ALARM },
      at: Date.now()
    };
    if (item.recurrence) {
      const next = nextFire(item.fireAt || Date.now(), item.recurrence, item.timezone);
      if (next) {
        item.fireAt = next;
        item.status = 'scheduled';
        item.snoozeUntil = null;
      }
    }
    await dbm.saveNow();
  }
  return item;
}

async function tick() {
  const list = due();
  const fired = [];
  for (const a of list) {
    let pushResult = null;
    try {
      const push = require('./push');
      pushResult = await push.pushAll({
        title: a.kind === 'reminder' ? 'ARIA reminder' : 'ARIA alarm',
        body: a.title + (a.body ? ' — ' + a.body : ''),
        url: '/#/settings',
        type: 'alarm',
        tag: 'aria-alarm-' + a.id
      });
    } catch (e) {
      pushResult = { error: (e && e.message) || 'push failed' };
    }
    const item = await markFired(a.id, {
      webPush: pushResult,
      browserNotification: 'server-tick',
      deviceAlarm: { ...DEVICE_ALARM }
    });
    if (item) fired.push(item);
  }
  return { fired: fired.length, items: fired };
}

function publicItem(a) {
  if (!a) return a;
  const { ...rest } = a;
  rest.deviceAlarm = { ...DEVICE_ALARM };
  rest.delivery = { ...(a.delivery || {}), deviceAlarm: false };
  return rest;
}

module.exports = {
  DEVICE_ALARM, parseWhen, parseRecurrence, isAmbiguousWhen, resolveTz, stripTzPhrases,
  create, list, formatList, cancel, snooze, due, tick, markFired, publicItem,
  findNextMeeting, hasClock, deliveryHint
};
