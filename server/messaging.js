'use strict';
/* Draft / send / list / read. Drafting never sends. Sending requires an explicit
   user confirmation (or a narrowly-scoped automation rule). Idempotency keys
   make retries safe. Group broadcasts are denied unless allowGroupSend is on. */
const crypto = require('crypto');
const dbm = require('./db');
const cfgm = require('./config');
const permissions = require('./permissions');
const integrations = require('./integrations');
const secrets = require('./secrets');
const { uid, dayKey } = require('./util');

const CHANNELS = new Set(['whatsapp', 'telegram', 'sms', 'email']);

function drafts() {
  const db = dbm.load();
  if (!Array.isArray(db.drafts)) db.drafts = [];
  return db.drafts;
}

function receipts() {
  const db = dbm.load();
  if (!db.meta) db.meta = {};
  if (!db.meta.sendReceipts || typeof db.meta.sendReceipts !== 'object') db.meta.sendReceipts = {};
  return db.meta.sendReceipts;
}

function looksLikeGroup(to, channel) {
  const s = String(to || '');
  if (/^#/.test(s) || /\bgroup\b/i.test(s)) return true;
  if (channel === 'telegram' && /^-?\d{10,}$/.test(s) && s.startsWith('-')) return true;
  if (channel === 'whatsapp' && /@g\.us\b/i.test(s)) return true;
  return false;
}

function resolveRecipient(raw, channel) {
  const name = String(raw || '').trim();
  if (!name) return { ok: false, reason: 'No recipient. Name a person or an address.' };
  const ch = String(channel || '').toLowerCase();
  if (ch === 'email' && /@/.test(name)) return { ok: true, to: name, display: name, unique: true, kind: 'email' };
  const digits = name.replace(/[^\d+]/g, '');
  if ((ch === 'sms' || ch === 'whatsapp') && /^\+?\d{7,15}$/.test(digits) && digits.replace(/\D/g, '').length >= 7) {
    return { ok: true, to: digits, display: digits, unique: true, kind: 'phone' };
  }
  if (ch === 'telegram' && (/^-?\d+$/.test(name) || /^@/.test(name))) {
    return { ok: true, to: name, display: name, unique: true, kind: 'telegram' };
  }
  const cfg = cfgm.load();
  const contacts = Array.isArray(cfg.contacts) ? cfg.contacts : [];
  const q = name.toLowerCase();
  const matches = contacts.filter((c) => {
    const n = String(c.name || '').toLowerCase();
    return n === q || n.startsWith(q) || n.split(/\s+/).includes(q);
  });
  if (matches.length > 1) {
    return { ok: false, reason: `Recipient "${name}" is ambiguous (${matches.map((c) => c.name).join(', ')}). I will not send until you pick one.`, candidates: matches.map((c) => c.name) };
  }
  if (matches.length === 1) {
    const c = matches[0];
    const dest = c.channels && c.channels[ch];
    if (!dest) return { ok: false, reason: `I know ${c.name}, but they have no ${ch} address. Add one in Settings → Contacts.` };
    return { ok: true, to: dest, display: c.name, unique: true, contactId: c.id, kind: 'contact' };
  }
  return { ok: false, reason: `I don't have a ${ch} destination for "${name}". Add them in Settings → Contacts, or give a phone number / email.` };
}

function makeIdempotency(explicit, draft) {
  if (explicit && String(explicit).trim()) return String(explicit).trim().slice(0, 120);
  return crypto.createHash('sha256')
    .update([draft.channel, draft.to, draft.body, draft.createdAt].join('|'))
    .digest('hex').slice(0, 32);
}

async function draftMessage({ channel, to, body, subject, source, idempotencyKey }) {
  const ch = String(channel || '').toLowerCase();
  if (!CHANNELS.has(ch)) return { ok: false, reply: `I can draft whatsapp, telegram, sms or email — not "${channel}".`, draft: null };
  const text = String(body || '').trim();
  if (!text) return { ok: false, reply: 'The message body is empty. Drafting did not send anything.', draft: null };
  const dest = resolveRecipient(to, ch);
  if (!dest.ok) return { ok: false, reply: dest.reason, draft: null, candidates: dest.candidates };
  if (looksLikeGroup(dest.to, ch) && !permissions.allowGroupSend()) {
    return { ok: false, reply: 'That looks like a group. Group broadcasts are blocked unless you enable them in Settings → Permissions.', draft: null };
  }
  const item = {
    id: uid('draft'),
    channel: ch,
    to: dest.to,
    toDisplay: dest.display,
    toRaw: String(to || ''),
    body: text.slice(0, 4000),
    subject: String(subject || '').slice(0, 200),
    status: 'draft',
    group: looksLikeGroup(dest.to, ch),
    source: source || 'assistant',
    idempotencyKey: String(idempotencyKey || '').slice(0, 120) || null,
    createdAt: Date.now(),
    sentAt: null,
    providerId: null,
    error: null
  };
  drafts().unshift(item);
  await dbm.saveNow();
  permissions.audit({ integration: ch, action: 'draft', status: 'ok', summary: `draft ${ch} to ${dest.display} (${text.length} chars)`, target: item.id });
  return {
    ok: true,
    intent: 'message-draft',
    draft: publicDraft(item),
    reply: `📝 **Draft ready** (${ch} → **${dest.display}**). Nothing was sent.\n\n> ${text.slice(0, 500)}\n\nSay **send it** after you check the destination and wording, or **cancel**.`
  };
}

function publicDraft(d) {
  if (!d) return d;
  return {
    id: d.id, channel: d.channel, toDisplay: d.toDisplay, toRaw: d.toRaw,
    body: d.body, subject: d.subject, status: d.status, group: !!d.group,
    createdAt: d.createdAt, sentAt: d.sentAt, providerId: d.providerId, error: d.error,
    idempotencyKey: d.idempotencyKey || null
  };
}

async function performSend(draft, { idempotencyKey } = {}) {
  const key = idempotencyKey || draft.idempotencyKey || makeIdempotency(null, draft);
  const recs = receipts();
  if (recs[key]) {
    return { ok: recs[key].ok, reply: recs[key].reply, duplicate: true, receipt: recs[key], sent: !!recs[key].ok };
  }
  const ch = draft.channel;
  let result;
  if (ch === 'telegram') result = await integrations.sendTelegram({ to: draft.to, body: draft.body });
  else if (ch === 'whatsapp') result = await integrations.sendWhatsApp({ to: draft.to, body: draft.body });
  else if (ch === 'sms') result = await integrations.sendSms({ to: draft.to, body: draft.body });
  else if (ch === 'email') result = await integrations.sendEmail({ to: draft.to, subject: draft.subject, body: draft.body });
  else result = { ok: false, error: `unsupported channel ${ch}` };

  if (result && result.ok) {
    draft.status = 'sent';
    draft.sentAt = Date.now();
    draft.providerId = result.providerId || null;
    draft.error = null;
    const reply = `✅ **Sent** via ${ch} to **${draft.toDisplay}** (provider confirmed${draft.providerId ? ` id ${draft.providerId}` : ''}).`;
    recs[key] = { ok: true, reply, providerId: draft.providerId, at: Date.now(), channel: ch, toDisplay: draft.toDisplay };
    permissions.audit({ integration: ch, action: 'send', status: 'ok', summary: `sent ${ch} to ${draft.toDisplay}`, target: draft.id });
    await dbm.saveNow();
    return { ok: true, reply, sent: true, draft: publicDraft(draft), receipt: recs[key] };
  }
  draft.status = 'failed';
  draft.error = secrets.safeError((result && result.error) || 'send failed');
  const reply = `The ${ch} provider did **not** confirm delivery: ${draft.error}. Nothing else was attempted.`;
  recs[key] = { ok: false, reply, error: draft.error, at: Date.now(), channel: ch, toDisplay: draft.toDisplay };
  permissions.audit({ integration: ch, action: 'send', status: 'error', summary: draft.error, target: draft.id });
  await dbm.saveNow();
  return { ok: false, reply, sent: false, draft: publicDraft(draft), receipt: recs[key] };
}

async function sendMessage({ channel, to, body, subject, source, idempotencyKey, origin, draftId, confirmed }) {
  if (origin === 'tool-loop' && confirmed) {
    return { ok: false, reply: 'A model cannot self-confirm a send. The owner must confirm in chat or tap Confirm.', sent: false };
  }
  let draft;
  if (draftId) {
    draft = drafts().find((d) => d && d.id === draftId);
    if (!draft) return { ok: false, reply: 'That draft was not found.', sent: false };
  } else {
    const made = await draftMessage({ channel, to, body, subject, source, idempotencyKey });
    if (!made.ok) return { ...made, sent: false };
    draft = drafts().find((d) => d.id === made.draft.id);
  }
  if (draft.group && !permissions.allowGroupSend()) {
    return { ok: false, reply: 'Group broadcasts are blocked. Enable them in Settings → Permissions if you really want that.', sent: false };
  }
  const destOk = resolveRecipient(draft.toDisplay || draft.toRaw || draft.to, draft.channel);
  if (!destOk.ok || destOk.candidates) {
    return { ok: false, reply: destOk.reason || 'Recipient is ambiguous — I will not send.', sent: false };
  }

  const integ = draft.channel;
  if (!permissions.allowed(integ, 'send') && !permissions.matchingRule({ integration: integ, action: 'send', to: draft.toDisplay, channel: draft.channel })) {
    /* Still allow a confirmation flow: the confirm step is the grant for a one-shot.
       But the integration must be connected. */
  }
  const st = integrations.one(integ === 'email' ? 'smtp' : integ);
  if (st && st.status === 'disabled') {
    return { ok: false, reply: `${integ} is disabled. Enable it in Settings → Connected apps first. Nothing was sent.`, sent: false };
  }
  if (st && (st.status === 'configured_not_authorized' || st.status === 'authorization_expired' || st.status === 'unavailable')) {
    return { ok: false, reply: `${integ} is **${st.status.replace(/_/g, ' ')}**. I will not pretend the message was delivered.`, sent: false };
  }

  const key = idempotencyKey || draft.idempotencyKey || makeIdempotency(null, draft);
  draft.idempotencyKey = key;
  const recs = receipts();
  if (recs[key]) {
    return { ok: recs[key].ok, reply: recs[key].reply + ' (repeat request — not sent again)', duplicate: true, sent: !!recs[key].ok };
  }

  if (permissions.needsConfirmation({
    integration: integ, action: 'send', to: draft.toDisplay, channel: draft.channel, origin
  })) {
    const cnf = permissions.createConfirmation({
      action: 'send',
      integration: integ,
      preview: {
        title: `Send ${integ} to ${draft.toDisplay}`,
        channel: integ,
        destination: draft.toDisplay,
        body: draft.body,
        kind: 'message'
      },
      payload: { type: 'send', draftId: draft.id, idempotencyKey: key }
    });
    permissions.audit({ integration: integ, action: 'send', status: 'pending', summary: `awaiting confirm ${integ} to ${draft.toDisplay}`, target: draft.id });
    return {
      ok: true,
      sent: false,
      needsConfirmation: true,
      confirmation: permissions.publicConfirmation(cnf),
      draft: publicDraft(draft),
      intent: 'message-confirm',
      reply: `I have **not** sent this.\n\n**Channel:** ${integ}\n**To:** ${draft.toDisplay}\n**Message:** ${draft.body}\n\nSay **confirm** to send, or **cancel**. A model cannot approve this for you.`
    };
  }

  return performSend(draft, { idempotencyKey: key });
}

function listMessages({ unread, day, channel, query, limit } = {}) {
  const db = dbm.load();
  const cfg = cfgm.load();
  const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
  const cap = Math.max(1, Math.min(50, Number(limit) || 20));
  let items = Array.isArray(db.messages) ? db.messages.slice() : [];
  if (channel) items = items.filter((m) => String(m.source || m.channel || '').toLowerCase().includes(String(channel).toLowerCase()));
  if (unread) items = items.filter((m) => !m.read);
  if (day) {
    const { parseQueryDay } = require('./assistant');
    const d = parseQueryDay(String(day).toLowerCase(), tz);
    items = items.filter((m) => dayKey(m.sentAt || m.ts || 0, tz) === d.key);
  }
  if (query) {
    const q = String(query).toLowerCase();
    items = items.filter((m) => `${m.from || ''} ${m.text || ''} ${m.channel || ''}`.toLowerCase().includes(q));
  }
  items.sort((a, b) => (b.sentAt || b.ts || 0) - (a.sentAt || a.ts || 0));
  return items.slice(0, cap);
}

function formatMessages(items, tz) {
  if (!items.length) return 'No messages match.';
  return items.map((m) => `- ${m.read ? '' : '**unread** '}[${m.channel || m.source}] **${m.from}**: ${String(m.text || '').slice(0, 140)}`).join('\n');
}

function readMessage(id) {
  const db = dbm.load();
  const m = (db.messages || []).find((x) => x && x.id === id);
  if (!m) return { ok: false, reply: 'Message not found.' };
  return { ok: true, message: m, reply: `**${m.from}** via ${m.channel || m.source}:\n\n${m.text || ''}` };
}

async function markRead(id) {
  const db = dbm.load();
  const m = (db.messages || []).find((x) => x && x.id === id);
  if (!m) return { ok: false, reply: 'Message not found.' };
  m.read = true;
  dbm.upsert('messages', m);
  await dbm.saveNow();
  return { ok: true, message: m, reply: `Marked "${String(m.text || '').slice(0, 40)}" as read.` };
}

function getDraft(id) {
  return drafts().find((d) => d && d.id === id) || null;
}

module.exports = {
  CHANNELS, resolveRecipient, looksLikeGroup,
  draftMessage, sendMessage, performSend, publicDraft, getDraft,
  listMessages, formatMessages, readMessage, markRead, receipts
};
