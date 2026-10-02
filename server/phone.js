'use strict';
/* ANDROID PHONE BRIDGE — REAL device alarms and media control, via Tasker or MacroDroid.
   ═══════════════════════════════════════════════════════════════════════════════════════
   How it works
     1. ARIA writes a COMMAND into an outbox (db.phoneCommands) instead of pretending the
        phone did something. Types: set_alarm, cancel_alarm, play, pause, next, previous,
        volume, open_app.
     2. The phone polls `GET /api/phone/pending` with `Authorization: Bearer <bridgeToken>`.
        Only UNEXPIRED, QUEUED commands are returned. Picking a command up stamps it as
        "seen" (attempts++, firstSeenAt) but does NOT mark it done.
     3. The phone runs the real action (Tasker "Set Alarm", media key intent, …) and calls
        `POST /api/phone/ack` with { id, status, detail }.
     4. Only when the ack arrives does ARIA say it happened. Before that, every reply is
        "sent to your phone — waiting for confirmation." Nothing is ever invented.
   Guarantees
     • OFF by default: `config.phone.enabled` is false and no token exists on a fresh install.
     • Default deny: every command needs an explicit grant — phone.alarm, phone.media or
       phone.app. Grants are audited. The model (origin 'tool-loop') cannot self-confirm a
       sensitive phone.alarm command; the owner must confirm in chat / the UI.
     • The bridge token is a secret (config secret-key rules): blanked in every GET body,
       never logged, never returned by /api/phone, never included in a command payload.
     • Idempotent: commands carry an idempotency key; a repeated enqueue returns the SAME
       command, and a repeated ack returns the first result without changing it.
     • Expiry: every command has a TTL; expired commands are never delivered and are
       reported honestly as expired.
   Alarm times are always resolved in Africa/Nairobi (owner timezone) and an ambiguous time
   asks first — nothing is queued until the owner gives a clock time.
*/
const crypto = require('crypto');
const dbm = require('./db');
const cfgm = require('./config');
const permissions = require('./permissions');
const secrets = require('./secrets');
const { uid, tzDate, dayLabel, timeStr } = require('./util');

const DEFAULT_TZ = 'Africa/Nairobi';
const COLLECTION = 'phoneCommands';
const AUDIT_CAP = 200;                       // keep the persisted document small

const COMMAND_TYPES = ['set_alarm', 'cancel_alarm', 'play', 'pause', 'next', 'previous', 'volume', 'open_app'];
const COMMAND_SET = new Set(COMMAND_TYPES);

/* Which grant each command needs. All three are default-deny. */
const TYPE_PERMISSION = {
  set_alarm: 'phone.alarm',
  cancel_alarm: 'phone.alarm',
  play: 'phone.media',
  pause: 'phone.media',
  next: 'phone.media',
  previous: 'phone.media',
  volume: 'phone.media',
  open_app: 'phone.app'
};

/* Exactly what the phone-side automation has to do. Kept here so the API payload and the
   docs can never drift apart. Tasker actions are named as they appear in Tasker 6.x. */
const TASKER = {
  set_alarm: { action: 'Task → Alert → Set Alarm', params: 'hour = args.hour, minute = args.minute, label = args.label' },
  cancel_alarm: { action: 'Task → Alert → Cancel Alarm (if present) — otherwise open Clock and cancel manually', params: 'label / id (ack as failed if the action does not exist)' },
  play: { action: 'Task → Media → Media Control: Play (or Send Intent MEDIA_BUTTON keycode 126)', params: '' },
  pause: { action: 'Task → Media → Media Control: Pause (or MEDIA_BUTTON keycode 127 / 85)', params: '' },
  next: { action: 'Task → Media → Media Control: Next (or Send Intent MEDIA_BUTTON keycode 87)', params: '' },
  previous: { action: 'Task → Media → Media Control: Previous (or Send Intent MEDIA_BUTTON keycode 88)', params: '' },
  volume: { action: 'Task → Media → Set Volume: Media, level = args.level', params: 'level 0–100' },
  open_app: { action: 'Task → App → Launch App', params: 'app = args.app' }
};

/* ─────────────────────────── config / state helpers ─────────────────────────── */
function phoneCfg() {
  let cfg = {};
  try { cfg = (cfgm.load() || {}).phone || {}; } catch (_) { cfg = {}; }
  const ttl = Number(cfg.commandTtlSeconds);
  const poll = Number(cfg.pollSeconds);
  return {
    enabled: !!cfg.enabled,
    bridgeToken: String(cfg.bridgeToken || '').trim(),
    label: String(cfg.label || 'Android phone').slice(0, 60),
    commandTtlSeconds: Number.isFinite(ttl) && ttl >= 60 ? Math.min(Math.round(ttl), 86400) : 1800,
    pollSeconds: Number.isFinite(poll) && poll >= 15 ? Math.min(Math.round(poll), 86400) : 300
  };
}

function configured() {
  const c = phoneCfg();
  return !!(c.enabled && c.bridgeToken);
}

function collection() {
  const db = dbm.load();
  if (!Array.isArray(db[COLLECTION])) db[COLLECTION] = [];
  while (db[COLLECTION].length > AUDIT_CAP) db[COLLECTION].pop();
  return db[COLLECTION];
}

function meta() {
  const db = dbm.load();
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  if (!db.meta.phone || typeof db.meta.phone !== 'object') db.meta.phone = {};
  return db.meta.phone;
}

/* Constant-time bearer-token check. Returns a status-shaped error the routes can use. */
function authenticate(token) {
  const c = phoneCfg();
  if (!c.enabled) return { ok: false, status: 409, error: 'Phone bridge is disabled. Enable it in Settings → Android phone bridge.' };
  if (!c.bridgeToken) return { ok: false, status: 409, error: 'Phone bridge has no token yet. Save one in Settings → Android phone bridge.' };
  const given = String(token || '').replace(/^Bearer\s+/i, '').trim();
  if (!given) return { ok: false, status: 401, error: 'Missing bearer token.' };
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(c.bridgeToken).digest();
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, error: 'Invalid bridge token.' };
  return { ok: true };
}

/* Mark un-acked, un-expired commands as expired. Pure in-memory sweep — callers persist. */
function sweep(now = Date.now()) {
  const list = collection();
  let changed = 0;
  for (const c of list) {
    if (c && c.status === 'queued' && Number(c.expiresAt) && Number(c.expiresAt) <= now) {
      c.status = 'expired';
      c.updatedAt = now;
      c.result = { status: 'expired', detail: 'Command expired before the phone picked it up.', at: now };
      changed++;
    }
  }
  return changed;
}

function publicCommand(c) {
  if (!c) return null;
  return {
    id: c.id,
    type: c.type,
    args: c.args || {},
    status: c.status,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    expiresAtISO: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    attempts: c.attempts || 0,
    firstSeenAt: c.firstSeenAt || null,
    lastSeenAt: c.lastSeenAt || null,
    ackedAt: c.ackedAt || null,
    result: c.result || null,
    human: c.human || '',
    /* What the phone-side automation should do — mirrors docs/ANDROID_BRIDGE.md. */
    tasker: TASKER[c.type] || null
  };
}

function humanFor(type, args, tz) {
  const zone = tz || DEFAULT_TZ;
  switch (type) {
    case 'set_alarm': {
      const when = args.epochMs ? `${dayLabel(args.epochMs, zone)} at ${timeStr(args.epochMs, zone)} (${zone})` : (args.label || 'a requested time');
      return `Set a real device alarm for ${when}${args.title ? ` — "${args.title}"` : ''}`;
    }
    case 'cancel_alarm': return `Cancel the phone alarm${args.title ? ` "${args.title}"` : ''}`;
    case 'play': return args.query ? `Play "${args.query}" on the phone` : 'Press play on the phone';
    case 'pause': return 'Pause media on the phone';
    case 'next': return 'Skip to the next track on the phone';
    case 'previous': return 'Go back to the previous track on the phone';
    case 'volume': return `Set the phone media volume to ${args.level}%`;
    case 'open_app': return `Open "${args.app}" on the phone`;
    default: return type;
  }
}

function waitingReply(c) {
  const label = phoneCfg().label;
  if (!c) return `Sent to ${label} — waiting for confirmation.`;
  return `📲 **Sent to ${label}** — ${c.human}. **Waiting for confirmation** (command \`${c.id}\`): I will only say it happened once your phone acks. Until then it is **queued, not confirmed**.`;
}

function ackSummary(c) {
  if (!c || !c.result) return 'No ack from the phone yet.';
  if (c.status === 'acked') return `✅ The phone confirmed: ${c.result.detail || c.human}.`;
  if (c.status === 'expired') return `⌛ That command expired before the phone picked it up (${c.human}). Nothing happened on the phone.`;
  if (c.status === 'failed') return `⚠️ The phone reported it could NOT run: ${c.result.detail || 'unknown reason'}. Nothing was confirmed.`;
  return 'Still waiting for the phone to ack.';
}

/* ─────────────────────────── audit (same trail as the hub) ─────────────────────────── */
function audit(action, status, summary, target) {
  return permissions.audit({ integration: 'phone', action, status, summary, target });
}

/* ─────────────────────────── payload validation ─────────────────────────── */
function cleanArgs(type, raw = {}) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const str = (v, n = 120) => secrets.redactText(String(v === null || v === undefined ? '' : v)).slice(0, n).trim();
  if (type === 'set_alarm') {
    const { parseWhen } = require('./alarms');
    const zone = str(a.timezone, 60) || DEFAULT_TZ;
    let epochMs = Number(a.fireAt || a.epochMs);
    if (!Number.isFinite(epochMs) && a.when) {
      const parsed = parseWhen(String(a.when), zone);
      epochMs = Number(parsed.fireAt);
      if (parsed.ambiguous || !Number.isFinite(epochMs)) {
        return { error: `I need an exact clock time for a real phone alarm (for example "tomorrow at 6:30 AM"). Nothing was sent to your phone.`, ambiguous: true, parsed };
      }
    }
    if (!Number.isFinite(epochMs)) return { error: 'I need a time for the phone alarm. Nothing was sent.', ambiguous: true };
    const p = tzDate(epochMs, zone);
    return {
      args: {
        epochMs,
        fireAtISO: new Date(epochMs).toISOString(),
        hour: Number(p.hour),
        minute: Number(p.minute),
        dayKey: `${p.year}-${p.month}-${p.day}`,
        timezone: zone,
        title: str(a.title || 'ARIA alarm', 80) || 'ARIA alarm',
        label: `ARIA ${timeStr(epochMs, zone)}`
      }
    };
  }
  if (type === 'cancel_alarm') return { args: { title: str(a.title, 80), fireAtISO: a.fireAtISO ? str(a.fireAtISO, 40) : undefined } };
  if (type === 'play') return { args: { query: str(a.query || a.media || a.title, 120), source: str(a.source, 40) || 'phone' } };
  if (type === 'volume') {
    const n = Number(a.level !== undefined ? a.level : (a.volume !== undefined ? a.volume : a.value));
    if (!Number.isFinite(n)) return { error: 'Give me a volume between 0 and 100 for the phone.' };
    return { args: { level: Math.max(0, Math.min(100, Math.round(n))) } };
  }
  if (type === 'open_app') {
    const app = str(a.app || a.name || a.query, 60);
    if (!app) return { error: 'Which app should I open on the phone?' };
    return { args: { app } };
  }
  return { args: {} };
}

function signature(type, args) {
  if (type !== 'set_alarm') return '';
  return `set_alarm:${args.dayKey}:${args.hour}:${args.minute}:${args.title || ''}`;
}

/* ─────────────────────────── the outbox ─────────────────────────── */
/**
 * Queue a command for the phone. Nothing is executed here and nothing is claimed as done.
 * @returns {Promise<object>} { ok, queued, duplicate?, command?, reply, needsConfirmation?, confirmation? }
 */
async function enqueue({ type, args, idempotencyKey, origin = 'user', ttlMs } = {}) {
  const t = String(type || '').trim().toLowerCase();
  if (!COMMAND_SET.has(t)) {
    return { ok: false, queued: false, reply: `I do not have a phone command called "${type}". Nothing was sent.`, intent: 'phone-error' };
  }
  const c = phoneCfg();
  const perm = TYPE_PERMISSION[t];
  const [integration, action] = perm.split('.');

  /* 1. The bridge must exist and be enabled. */
  if (!c.enabled) {
    audit('command', 'denied', `${t} — bridge disabled`);
    return {
      ok: false, queued: false, intent: 'phone-disabled',
      reply: `The **Android phone bridge is off**, so nothing was sent to your phone. Turn it on in Settings → Android phone bridge (Tasker/MacroDroid), add a bridge token, and grant \`${perm}\`.`
    };
  }
  if (!c.bridgeToken) {
    audit('command', 'denied', `${t} — no token configured`);
    return {
      ok: false, queued: false, intent: 'phone-unconfigured',
      reply: `The phone bridge has no token yet, so I cannot queue anything. Save a bridge token in Settings → Android phone bridge, then copy the same token into Tasker.`
    };
  }

  /* 2. Default deny: explicit grant required for the action class. */
  if (!permissions.allowed(integration, action)) {
    audit(t, 'denied', `${perm} not granted`);
    return {
      ok: false, queued: false, intent: 'phone-denied',
      reply: `I am not allowed to use \`${perm}\` yet — permission is **denied by default**. Grant it in Settings → Permissions (🔐) and I will send it to your phone. Nothing was sent.`
    };
  }

  /* 3. A model (tool loop) can never self-confirm a real device alarm. An owner-typed,
     already-granted request is itself the authorisation — the ack is what makes it true. */
  if (origin === 'tool-loop' && permissions.needsConfirmation({ integration, action, origin })) {
    const rec = permissions.createConfirmation({
      action: `phone_${t}`,
      integration: 'phone',
      preview: {
        title: 'Phone command',
        kind: 'phone',
        channel: 'Tasker/MacroDroid bridge',
        destination: c.label,
        whenLabel: t === 'set_alarm' && args && (args.when || args.fireAt) ? String(args.when || args.fireAt) : '',
        body: `${t} ${JSON.stringify(args || {})}`.slice(0, 300)
      },
      payload: { type: 'phone', command: t, args: args || {}, idempotencyKey }
    });
    audit(t, 'pending-owner-confirm', 'tool loop asked for a phone command');
    return {
      ok: false, queued: false, needsConfirmation: true,
      confirmation: permissions.publicConfirmation(rec),
      intent: `phone-${t}`,
      reply: `That would send a real command to your phone (${t}). A model cannot confirm that by itself — say **confirm** or tap Confirm and I will send it. Nothing was sent yet.`
    };
  }

  /* 4. Validate the payload (ambiguous alarm times stop here — nothing is queued). */
  const cleaned = cleanArgs(t, args);
  if (cleaned.error) {
    audit(t, 'invalid', cleaned.error);
    return { ok: false, queued: false, intent: `phone-${t}`, reply: cleaned.error, ambiguous: !!cleaned.ambiguous };
  }
  const payload = cleaned.args;
  payload.timezone = payload.timezone || DEFAULT_TZ;

  /* 5. Idempotency — a repeated intent returns the SAME queued command. */
  const list = collection();
  const key = String(idempotencyKey || '').trim() || signature(t, payload);
  if (key) {
    const dup = list.find((x) => x && x.idempotencyKey === key && x.status === 'queued');
    if (dup) {
      audit(t, 'duplicate', `reused queued command ${dup.id}`);
      return { ok: true, queued: false, duplicate: true, command: publicCommand(dup), intent: `phone-${t}`, reply: waitingReply(dup) };
    }
  }

  const now = Date.now();
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : c.commandTtlSeconds * 1000;
  const cmd = {
    id: uid('phc'),
    type: t,
    args: payload,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttl,
    attempts: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    ackedAt: null,
    result: null,
    push: null,
    idempotencyKey: key || null,
    origin,
    human: humanFor(t, payload, payload.timezone)
  };
  list.unshift(cmd);
  meta().lastEnqueueAt = now;
  const m = meta();
  m.pendingCount = list.filter((x) => x.status === 'queued' && x.expiresAt > now).length;
  audit(t, 'queued', cmd.human, cmd.id);

  /* Optional web-push fallback with a FIXED title format Tasker/AutoNotification can read. */
  try { cmd.push = await sendPushFallback(cmd); } catch (_) { cmd.push = { skipped: 'push unavailable' }; }

  return { ok: true, queued: true, command: publicCommand(cmd), intent: `phone-${t}`, reply: waitingReply(publicCommand(cmd)) };
}

/** Everything the phone should run right now. Authenticated + swept. */
async function pending({ token, now = Date.now() } = {}) {
  const auth = authenticate(token);
  if (!auth.ok) return auth;
  sweep(now);
  const list = collection()
    .filter((c) => c && c.status === 'queued' && c.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => {
      c.attempts = (c.attempts || 0) + 1;
      c.lastSeenAt = now;
      if (!c.firstSeenAt) c.firstSeenAt = now;
      return publicCommand(c);
    });
  const m = meta();
  m.lastPollAt = now;
  m.lastPollCount = list.length;
  m.pendingCount = list.length;
  try { await dbm.saveNow(); } catch (_) {}
  return { ok: true, count: list.length, commands: list };
}

/** The phone reports what really happened. First ack wins; repeats are idempotent. */
async function ack({ token, id, status, detail } = {}) {
  const auth = authenticate(token);
  if (!auth.ok) return auth;
  const now = Date.now();
  sweep(now);
  const cmd = collection().find((c) => c && c.id === String(id || '').trim());
  if (!cmd) return { ok: false, status: 404, error: 'Unknown or already purged command id.' };
  if (cmd.status !== 'queued') {
    return { ok: true, duplicate: true, command: publicCommand(cmd), reply: ackSummary(cmd) };
  }
  const raw = String(status || 'done').toLowerCase();
  const failed = raw === 'failed' || raw === 'error' || raw === 'unsupported';
  cmd.status = failed ? 'failed' : 'acked';
  cmd.ackedAt = now;
  cmd.updatedAt = now;
  cmd.result = { status: raw.slice(0, 40), detail: secrets.redactText(String(detail || '')).slice(0, 300), at: now };
  const m = meta();
  m.lastAckAt = now;
  m.lastAck = { id: cmd.id, type: cmd.type, status: cmd.status, detail: cmd.result.detail };
  m.pendingCount = collection().filter((x) => x.status === 'queued').length;
  audit(cmd.type, cmd.status === 'acked' ? 'acked' : 'failed', cmd.result.detail || cmd.human, cmd.id);
  try { await dbm.saveNow(); } catch (_) {}
  return { ok: true, duplicate: false, command: publicCommand(cmd), reply: ackSummary(cmd.result ? cmd : null) };
}

/** Owner-side cancel (UI). Nothing on the phone is touched — that needs its own ack. */
async function cancel(id) {
  const cmd = collection().find((c) => c && c.id === id);
  if (!cmd) return { ok: false, error: 'unknown command' };
  if (cmd.status === 'queued') {
    cmd.status = 'cancelled';
    cmd.updatedAt = Date.now();
    audit(cmd.type, 'cancelled', cmd.human, cmd.id);
    try { await dbm.saveNow(); } catch (_) {}
  }
  return { ok: true, command: publicCommand(cmd) };
}

/* ─────────────────────────── web-push fallback (fixed titles) ─────────────────────────── */
/** Pure: the notification Tasker/AutoNotification can pattern-match. */
function pushPayload(cmd) {
  if (!cmd || !cmd.type) return null;
  const a = cmd.args || {};
  const zone = a.timezone || DEFAULT_TZ;
  let title = 'ARIA PHONE';
  if (cmd.type === 'set_alarm') {
    const p = a.epochMs ? tzDate(a.epochMs, zone) : null;
    title = `ARIA ALARM ${p ? `${p.hour}:${p.minute}` : (a.label || '')}`.trim();
  } else if (cmd.type === 'cancel_alarm') {
    title = 'ARIA ALARM CANCEL';
  } else if (cmd.type === 'volume') {
    title = `ARIA MEDIA VOLUME ${a.level}`;
  } else if (cmd.type === 'open_app') {
    title = `ARIA APP ${a.app}`.toUpperCase().slice(0, 40);
  } else {
    title = `ARIA MEDIA ${String(cmd.type).toUpperCase()}`;
  }
  return {
    title,
    body: `ARIA phone command ${cmd.type} · id ${cmd.id} — if the polling profile missed it, open ARIA and re-send.`,
    url: '/#/settings',
    type: 'phone-command',
    tag: `aria-phone-${cmd.id}`,
    data: { ariaPhoneCommand: cmd.type, ariaCommandId: cmd.id, enqueuedAt: cmd.createdAt }
  };
}

async function sendPushFallback(cmd) {
  const payload = pushPayload(cmd);
  if (!payload) return { skipped: 'no payload' };
  try {
    const push = require('./push');
    return await push.pushAll(payload);
  } catch (e) {
    return { skipped: secrets.safeError(e) };
  }
}

/* ─────────────────────────── owner-facing snapshot ─────────────────────────── */
function publicState() {
  sweep();
  const c = phoneCfg();
  const list = collection();
  const pendingCount = list.filter((x) => x.status === 'queued').length;
  const recent = list.slice(0, 8).map(publicCommand);
  const ackedCount = list.filter((x) => x.status === 'acked').length;
  const m = meta();
  return {
    enabled: c.enabled,
    configured: configured(),
    /* Never the token itself — only whether one exists. */
    tokenConfigured: !!c.bridgeToken,
    label: c.label,
    commandTtlSeconds: c.commandTtlSeconds,
    pollSeconds: c.pollSeconds,
    pendingCount,
    ackedCount,
    lastPollAt: m.lastPollAt || null,
    lastAckAt: m.lastAckAt || null,
    lastAck: m.lastAck || null,
    lastEnqueueAt: m.lastEnqueueAt || null,
    recent,
    commandTypes: COMMAND_TYPES.slice(),
    permissionHint: 'Commands need an explicit grant: phone.alarm, phone.media or phone.app (default deny).',
    docs: 'docs/ANDROID_BRIDGE.md'
  };
}

/* ─────────────────────────── deterministic intents ─────────────────────────── */
const PHONE_HINT_RE = /\b(?:my|the|this)\s+(?:phone|android|device|simu)\b|\b(?:phone|android|simu)\b/i;

function phoneStatusReply() {
  const st = publicState();
  const label = st.label;
  if (!st.enabled) {
    return {
      reply: `📵 The **Android phone bridge is off**. Nothing can reach your phone. Turn it on in Settings → Android phone bridge, then add the bridge token to Tasker.\n\nSetup guide: \`docs/ANDROID_BRIDGE.md\`.`,
      intent: 'phone-status'
    };
  }
  const lines = [
    `📲 **${label} bridge**: ${st.enabled ? 'enabled' : 'off'} · token ${st.tokenConfigured ? 'saved' : 'NOT saved'} · ${st.pendingCount} queued · last poll ${st.lastPollAt ? new Date(st.lastPollAt).toISOString().slice(11, 19) + 'Z' : 'never'}.`
  ];
  if (st.lastAck) lines.push(`Last ack: \`${st.lastAck.type}\` → **${st.lastAck.status}**${st.lastAck.detail ? ` (${st.lastAck.detail})` : ''}.`);
  if (st.pendingCount) lines.push('Queued commands are **not confirmed** until the phone acks them.');
  return { reply: lines.join('\n'), intent: 'phone-status', phone: st };
}

/**
 * Deterministic routing for phone phrasings, e.g.
 *   "set an alarm on my phone for tomorrow at 6:30 am"  → set_alarm
 *   "pause the music on my phone"                      → pause
 *   "next track on my android"                         → next
 *   "open WhatsApp on my phone"                        → open_app
 * Returns null when the message is not about the phone (so existing paths are untouched).
 */
async function route(sm, { origin = 'user' } = {}) {
  const s = String(sm || '').trim();
  if (!s || !PHONE_HINT_RE.test(s)) return null;

  if (/\b(?:status|connected|online|reachable|last seen|pending|queued|bridge)\b/i.test(s)) return phoneStatusReply();

  let m = s.match(/\b(?:set|create|add|make|weka)\b[^.]{0,40}?\balarm\b/i);
  if (m) {
    const mm = s.match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/i);
    const when = s
      .replace(/\b(?:on|to)\s+(?:my|the)\s+(?:phone|android|device|simu)\b/gi, ' ')
      .replace(/\b(?:phone|android|simu)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ').trim();
    const titleM = s.match(/\b(?:labelled|labeled|called|named)\s+([\w .'-]{2,40})$/i);
    const res = await enqueue({
      type: 'set_alarm',
      args: { when: mm ? when : '', title: titleM ? titleM[1].trim() : 'ARIA alarm', timezone: DEFAULT_TZ },
      origin
    });
    /* A missing/ambiguous time is a QUESTION, not a pending confirmation — nothing is queued. */
    return { ...res, ambiguous: !!(res.ambiguous) };
  }

  if (/\b(?:cancel|delete|remove|clear|off)\b[^.]{0,40}?\balarm\b/i.test(s)) {
    const t = s.match(/\b(?:for|at)\s+(.+)$/i);
    return await enqueue({ type: 'cancel_alarm', args: { title: t ? t[1].trim() : '' }, origin });
  }

  if (/\b(?:next|skip)\b/i.test(s) && /\b(?:track|song|music|one)\b/i.test(s)) return await enqueue({ type: 'next', args: {}, origin });
  if (/\b(?:previous|prev|go back|last track)\b/i.test(s)) return await enqueue({ type: 'previous', args: {}, origin });
  if (/\b(?:pause|stop)\b/i.test(s) && /\b(?:music|song|track|audio|playback|it)\b/i.test(s)) return await enqueue({ type: 'pause', args: {}, origin });
  if (/\b(?:resume|continue|unpause)\b/i.test(s)) return await enqueue({ type: 'play', args: {}, origin });
  m = s.match(/\bplay\b\s*(.*)$/i);
  if (m) {
    const query = m[1]
      .replace(/\b(?:on|to|through|via)\s+(?:my|the)\s+(?:phone|android|device|simu)\b/gi, ' ')
      .replace(/\b(?:phone|android|simu)\b/gi, ' ')
      .replace(/\b(?:music|some music|a song|song|track)\b/gi, ' ')
      .replace(/^(?:some|a|an|the)\s+/i, '')
      .replace(/\s{2,}/g, ' ').trim();
    return await enqueue({ type: 'play', args: { query: query.slice(0, 120) }, origin });
  }
  m = s.match(/\bvolume\b[^\d]{0,12}(\d{1,3})\b/i) || s.match(/\b(\d{1,3})\s*(?:%|percent)\b/i);
  if (m) return await enqueue({ type: 'volume', args: { level: m[1] }, origin });
  m = s.match(/\b(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?([A-Za-z][\w .'&+-]{1,40}?)(?:\s+(?:on|in)\s+(?:my|the)\s+(?:phone|android|device|simu))?\s*[.!?]*$/i);
  if (m) {
    const app = m[1]
      .replace(/^(?:my|the)\s+(?:phone|android|device|simu)\s+/i, '')
      .replace(/\b(?:app|please)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ').trim();
    if (app) return await enqueue({ type: 'open_app', args: { app }, origin });
  }
  return null;
}

/* ─────────────────────────── LLM tool schema ─────────────────────────── */
const TOOL_DEFS = [{
  name: 'phone_command',
  description: 'Send a REAL command to the owner\'s Android phone through the Tasker/MacroDroid bridge (device alarm, media control, open app). Default-deny: needs phone.alarm / phone.media / phone.app. The reply is "queued, waiting for the phone to ack" — it is NEVER confirmed until the phone acks. Ambiguous alarm times ask first.',
  args: {
    command: { type: 'set_alarm | cancel_alarm | play | pause | next | previous | volume | open_app' },
    when: { type: 'natural language or ISO alarm time (Africa/Nairobi)', optional: true },
    timezone: { type: 'IANA tz, default Africa/Nairobi', optional: true },
    query: { type: 'what to play (play only)', optional: true },
    app: { type: 'app name (open_app only)', optional: true },
    level: { type: 'volume 0–100 (volume only)', optional: true }
  }
}];
const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

async function executeTool(name, args, origin = 'assistant') {
  if (!TOOL_NAMES.has(String(name || '').trim())) return null;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const command = String(a.command || a.type || a.action || '').trim().toLowerCase();
  if (!COMMAND_SET.has(command)) return null;
  const payload = {
    when: a.when !== undefined ? a.when : (a.startISO !== undefined ? a.startISO : a.time),
    fireAt: a.fireAt,
    timezone: a.timezone,
    title: a.title,
    query: a.query !== undefined ? a.query : a.media,
    app: a.app !== undefined ? a.app : a.name,
    level: a.level !== undefined ? a.level : a.volume
  };
  return await enqueue({ type: command, args: payload, origin });
}

/* ─────────────────────────── test helper ─────────────────────────── */
function _reset() {
  const db = dbm.load();
  db[COLLECTION] = [];
  if (db.meta && db.meta.phone) delete db.meta.phone;
}

module.exports = {
  COMMAND_TYPES, TYPE_PERMISSION, TASKER,
  phoneCfg, configured, authenticate, sweep, publicCommand, publicState,
  enqueue, pending, ack, cancel,
  pushPayload, sendPushFallback,
  route, phoneStatusReply, waitingReply, ackSummary,
  TOOL_DEFS, executeTool,
  _reset
};
