'use strict';
/* Central permission policy.
   Default is deny. Sensitive actions need an explicit user confirmation (chat or UI)
   unless a narrowly-scoped automation rule matches. A model / tool-loop can never
   self-confirm — tokens are never returned to the LLM or in GET bodies. */
const crypto = require('crypto');
const dbm = require('./db');
const cfgm = require('./config');
const secrets = require('./secrets');
const { uid } = require('./util');

const SENSITIVE = new Set([
  'email.send', 'telegram.send', 'whatsapp.send', 'sms.send',
  'message.send', 'slack.send', 'calendar.delete', 'message.delete',
  /* A REAL device alarm on the owner's phone: the model may ask, but only the owner
     can confirm it (grants are checked separately, in phone.enqueue()). */
  'phone.alarm'
]);

const CONFIRM_TTL_MS = 5 * 60 * 1000;
const AUDIT_CAP = 500;

function permCfg() {
  const cfg = cfgm.load();
  return cfg.permissions || { grants: {}, allowGroupSend: false, autoSendRules: [] };
}

function grantKey(integration, action) {
  return `${String(integration || '').trim()}.${String(action || '').trim()}`;
}

function isSensitive(integration, action) {
  return SENSITIVE.has(grantKey(integration, action));
}

/* Local, non-destructive actions are allowed without a stored grant. Everything
   that talks to an external network on the owner's behalf defaults to deny. */
function allowed(integration, action) {
  const integ = String(integration || '');
  const act = String(action || '');
  if (integ === 'alarms' || integ === 'reminders' || integ === 'brain') return true;
  if (integ === 'media' && act !== 'purchase') return true;
  if (integ === 'calendar' && (act === 'read' || act === 'create' || act === 'list')) return true;
  if (integ === 'messages' && (act === 'read' || act === 'list' || act === 'draft' || act === 'mark_read')) return true;
  const g = permCfg().grants || {};
  if (g[grantKey(integ, act)] === true) return true;
  if (g[integ] === true) return true;
  return false;
}

function matchingRule({ integration, action, to, channel }) {
  const rules = permCfg().autoSendRules || [];
  const dest = String(to || '').trim().toLowerCase();
  const ch = String(channel || '').trim().toLowerCase();
  return rules.find((r) => r && r.enabled
    && String(r.integration || '') === String(integration || '')
    && String(r.action || 'send') === String(action || 'send')
    && (!r.channel || String(r.channel).toLowerCase() === ch)
    && (!r.to || String(r.to).toLowerCase() === dest)) || null;
}

function allowGroupSend() {
  return permCfg().allowGroupSend === true;
}

function needsConfirmation({ integration, action, to, channel, origin }) {
  if (origin === 'tool-loop') {
    if (isSensitive(integration, action) || isSensitive(channel || integration, action)) return true;
  }
  if (!isSensitive(integration, action) && !isSensitive(channel || integration, action)) return false;
  if (matchingRule({ integration, action, to, channel })) return false;
  return true;
}

function pendingList() {
  const db = dbm.load();
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  if (!Array.isArray(db.meta.pendingConfirmations)) db.meta.pendingConfirmations = [];
  return db.meta.pendingConfirmations;
}

function prunePending() {
  const now = Date.now();
  const db = dbm.load();
  db.meta.pendingConfirmations = pendingList().filter((c) => c && (c.status !== 'pending' || c.expiresAt > now)).slice(0, 20);
}

function createConfirmation({ action, integration, preview, payload }) {
  prunePending();
  const rec = {
    id: uid('cnf'),
    token: crypto.randomBytes(16).toString('hex'),
    action: String(action || ''),
    integration: String(integration || ''),
    preview: {
      title: String((preview && preview.title) || action || 'Action'),
      channel: preview && preview.channel ? String(preview.channel) : '',
      destination: preview && preview.destination ? String(preview.destination) : '',
      body: preview && preview.body ? String(preview.body).slice(0, 2000) : '',
      whenLabel: preview && preview.whenLabel ? String(preview.whenLabel) : '',
      kind: preview && preview.kind ? String(preview.kind) : ''
    },
    payload: payload || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONFIRM_TTL_MS,
    status: 'pending'
  };
  pendingList().unshift(rec);
  return rec;
}

function publicConfirmation(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    action: rec.action,
    integration: rec.integration,
    preview: rec.preview,
    expiresAt: rec.expiresAt,
    status: rec.status
  };
}

function getPending(id) {
  prunePending();
  const now = Date.now();
  return pendingList().find((c) => c && c.id === id && c.status === 'pending' && c.expiresAt > now) || null;
}

function latestPending() {
  prunePending();
  const now = Date.now();
  return pendingList().find((c) => c && c.status === 'pending' && c.expiresAt > now) || null;
}

function consume(id, { origin } = {}) {
  if (origin === 'tool-loop') {
    return { ok: false, error: 'A model cannot confirm a sensitive action. The owner must confirm in chat or tap Confirm.' };
  }
  const rec = getPending(id);
  if (!rec) return { ok: false, error: 'No pending confirmation (it may have expired).' };
  rec.status = 'confirmed';
  rec.confirmedAt = Date.now();
  rec.confirmedOrigin = origin || 'user';
  return { ok: true, rec };
}

function cancel(id) {
  const rec = pendingList().find((c) => c && c.id === id);
  if (rec && rec.status === 'pending') rec.status = 'cancelled';
  return { ok: true };
}

/* Prompt-injection resistant: long pastes, email headers, URLs and calendar
   contents never count as confirmation. Only a short, user-typed phrase does. */
function isExplicitUserConfirm(msg) {
  const t = String(msg || '').trim();
  if (!t || t.length > 80) return false;
  if (/\n/.test(t)) return false;
  if (/^from\s*:|^subject\s*:|^to\s*:|^https?:\/\//i.test(t)) return false;
  return /^(?:yes|y|ok|okay|confirm|confirmed|send it|send|do it|approve|proceed|go ahead)(?:[.!\s]*)$/i.test(t)
    || /^(?:confirm|approve)\s+(?:send|it|the\s+message|the\s+alarm|this)?[.!\s]*$/i.test(t);
}

function isExplicitUserCancel(msg) {
  const t = String(msg || '').trim();
  if (!t || t.length > 80 || /\n/.test(t)) return false;
  return /^(?:no|n|cancel|stop|don't|dont|never mind|nevermind|abort)(?:[.!\s]*)$/i.test(t);
}

function audit({ integration, action, status, summary, target }) {
  const db = dbm.load();
  if (!Array.isArray(db.audit)) db.audit = [];
  const ev = {
    id: uid('audit'),
    ts: Date.now(),
    integration: String(integration || ''),
    action: String(action || ''),
    status: String(status || ''),
    summary: secrets.redactText(String(summary || '')).slice(0, 400),
    target: secrets.redactText(String(target || '')).slice(0, 160)
  };
  db.audit.unshift(ev);
  if (db.audit.length > AUDIT_CAP) db.audit.length = AUDIT_CAP;
  return ev;
}

function listAudit(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return (dbm.load().audit || []).slice(0, n);
}

async function setGrant(key, value) {
  const cfg = cfgm.load();
  const permissions = {
    grants: {},
    allowGroupSend: false,
    autoSendRules: [],
    ...(cfg.permissions || {})
  };
  permissions.grants = { ...(permissions.grants || {}), [key]: !!value };
  await cfgm.save({ permissions });
  audit({
    integration: String(key).split('.')[0],
    action: 'grant',
    status: value ? 'ok' : 'revoked',
    summary: `${key} ${value ? 'granted' : 'revoked'}`
  });
  return permissions;
}

async function setAllowGroup(value) {
  const cfg = cfgm.load();
  const permissions = { grants: {}, autoSendRules: [], ...(cfg.permissions || {}), allowGroupSend: !!value };
  await cfgm.save({ permissions });
  audit({ integration: 'messages', action: 'allowGroupSend', status: value ? 'ok' : 'revoked', summary: `group send ${value ? 'enabled' : 'disabled'}` });
  return permissions;
}

function publicState() {
  const p = permCfg();
  return {
    grants: p.grants || {},
    allowGroupSend: !!p.allowGroupSend,
    autoSendRules: (p.autoSendRules || []).map((r) => ({
      id: r.id, integration: r.integration, action: r.action, channel: r.channel, to: r.to, enabled: !!r.enabled
    })),
    pending: publicConfirmation(latestPending()),
    sensitive: [...SENSITIVE]
  };
}

module.exports = {
  SENSITIVE, allowed, isSensitive, matchingRule, allowGroupSend, needsConfirmation,
  createConfirmation, publicConfirmation, getPending, latestPending, consume, cancel,
  isExplicitUserConfirm, isExplicitUserCancel, audit, listAudit, setGrant, setAllowGroup,
  publicState, grantKey
};
