'use strict';
/* Opt-in integration registry. Default is disabled. Credentials never appear in
   GET bodies. OAuth is used where we already have a Google client; Microsoft
   keeps the existing pasted Graph token. WhatsApp is official Cloud API only. */
const crypto = require('crypto');
const cfgm = require('./config');
const dbm = require('./db');
const secrets = require('./secrets');
const permissions = require('./permissions');
const connectors = require('./connectors');

let fetchImpl = (...args) => fetch(...args);
function _setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

const SCOPES = {
  google: ['gmail.readonly', 'calendar.readonly'],
  microsoft: ['Mail.Read', 'Calendars.Read'],
  slack: ['channels:read', 'channels:history', 'im:history', 'groups:history'],
  whatsapp: ['whatsapp_business_messaging'],
  telegram: ['bot.sendMessage'],
  smtp: ['email.send'],
  sms: ['sms.send (device bridge)'],
  media: ['browser media / local audio']
};

function flagExpired(id) {
  const db = dbm.load();
  if (!db.meta) db.meta = {};
  if (!db.meta.connectorErrors) db.meta.connectorErrors = {};
  return !!(db.meta.connectorErrors[id] && db.meta.connectorErrors[id].expired);
}

function markExpired(id, message) {
  const db = dbm.load();
  if (!db.meta) db.meta = {};
  if (!db.meta.connectorErrors) db.meta.connectorErrors = {};
  db.meta.connectorErrors[id] = { expired: true, message: secrets.safeError(message), ts: Date.now() };
}

function clearExpired(id) {
  const db = dbm.load();
  if (db.meta && db.meta.connectorErrors) delete db.meta.connectorErrors[id];
}

function classify({ enabled, configured, expired, unavailable }) {
  if (unavailable) return 'unavailable';
  if (!enabled) return 'disabled';
  if (expired) return 'authorization_expired';
  if (!configured) return 'configured_not_authorized';
  return 'connected';
}

function extraStatus() {
  const cfg = cfgm.load();
  const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const items = [];

  const tg = cfg.telegram || {};
  items.push({
    id: 'telegram',
    label: 'Telegram bot',
    enabled: !!tg.enabled,
    configured: !!(tg.token && String(tg.token).trim()),
    setupRequired: !(tg.token && String(tg.token).trim()),
    scopes: SCOPES.telegram,
    status: classify({
      enabled: !!tg.enabled,
      configured: !!(tg.token && String(tg.token).trim()),
      expired: false,
      unavailable: false
    }),
    authorized: !!(tg.enabled && tg.token),
    actions: ['send', 'revoke']
  });

  const smtp = cfg.smtp || {};
  items.push({
    id: 'smtp',
    label: 'Email (SMTP)',
    enabled: !!(smtp.host && smtp.user && smtp.to),
    configured: !!(smtp.host && smtp.user),
    setupRequired: !(smtp.host && smtp.user),
    scopes: SCOPES.smtp,
    status: classify({
      enabled: !!(smtp.host && smtp.user),
      configured: !!(smtp.host && smtp.user && smtp.pass),
      expired: false,
      unavailable: false
    }),
    authorized: !!(smtp.host && smtp.user && smtp.pass),
    actions: ['send', 'revoke']
  });

  const sms = cfg.sms || {};
  const smsConfigured = !!(sms.bridgeUrl && sms.token);
  items.push({
    id: 'sms',
    label: 'SMS (local device bridge)',
    enabled: !!sms.enabled,
    configured: smsConfigured,
    setupRequired: !smsConfigured,
    scopes: SCOPES.sms,
    status: classify({
      enabled: !!sms.enabled,
      configured: smsConfigured,
      expired: false,
      unavailable: serverless && !smsConfigured
    }),
    authorized: !!(sms.enabled && smsConfigured),
    unavailableReason: serverless && !smsConfigured ? 'No SMS bridge configured in this environment.' : '',
    actions: ['send', 'revoke']
  });

  const media = cfg.media || {};
  items.push({
    id: 'media',
    label: 'Browser / local media',
    enabled: true,
    configured: true,
    setupRequired: false,
    scopes: SCOPES.media,
    status: 'connected',
    authorized: true,
    actions: ['play', 'pause', 'resume', 'skip', 'volume'],
    note: 'Spotify and Apple Music are not connected. Local audio URL is optional.'
  });

  /* Android phone bridge (Tasker / MacroDroid) — off by default, needs a token + explicit grants. */
  const ph = cfg.phone || {};
  const phConfigured = !!(ph.enabled && ph.bridgeToken);
  let phonePending = 0;
  try { phonePending = require('./phone').publicState().pendingCount; } catch (_) { phonePending = 0; }
  items.push({
    id: 'phone',
    label: 'Android phone bridge (Tasker / MacroDroid)',
    enabled: !!ph.enabled,
    configured: phConfigured,
    setupRequired: !phConfigured,
    scopes: ['phone.alarm', 'phone.media', 'phone.app'],
    status: classify({ enabled: !!ph.enabled, configured: phConfigured, expired: false, unavailable: false }),
    authorized: phConfigured,
    actions: ['set_alarm', 'cancel_alarm', 'play', 'pause', 'next', 'previous', 'volume', 'open_app'],
    pendingCommands: phonePending,
    note: phConfigured
      ? `Phone polls GET /api/phone/pending with a bearer token; ${phonePending} command(s) queued. ARIA never claims an alarm/playback until the phone acks.`
      : 'Off by default. Enable in Settings → Android phone bridge and follow docs/ANDROID_BRIDGE.md.'
  });

  const contacts = Array.isArray(cfg.contacts) ? cfg.contacts.length : 0;
  items.push({
    id: 'contacts',
    label: 'Contacts (local)',
    enabled: true,
    configured: contacts > 0,
    setupRequired: contacts === 0,
    scopes: ['resolve recipients'],
    status: contacts ? 'connected' : 'disabled',
    authorized: contacts > 0,
    actions: []
  });

  return items;
}

function status() {
  const base = connectors.status().map((c) => {
    const expired = flagExpired(c.id);
    const unavailable = false;
    const st = classify({
      enabled: !!c.enabled,
      configured: !!c.configured,
      expired,
      unavailable
    });
    return {
      ...c,
      status: st,
      authorized: !!(c.enabled && c.configured && !expired),
      scopes: SCOPES[c.id] || [],
      actions: c.id === 'google' ? ['oauth', 'sync', 'revoke'] : ['sync', 'revoke']
    };
  });
  return base.concat(extraStatus());
}

function one(id) {
  return status().find((c) => c.id === id) || null;
}

function oauthStart(provider, req) {
  const p = String(provider || '').toLowerCase();
  if (p !== 'google') {
    return {
      ok: false,
      error: p === 'microsoft'
        ? 'Microsoft uses a pasted Graph token in Settings (device-code). In-app OAuth is not wired for Azure in this build.'
        : `OAuth start is not available for "${p}".`
    };
  }
  const cfg = cfgm.load();
  const g = (cfg.connectors && cfg.connectors.google) || {};
  if (!g.clientId) return { ok: false, error: 'Add a Google OAuth Client ID in Settings first.' };
  const proto = String((req && (req.headers['x-forwarded-proto'] || req.protocol)) || 'http').split(',')[0].trim();
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost:3000';
  const redirect = `${proto}://${host}/api/oauth/google/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  const db = dbm.load();
  if (!db.meta) db.meta = {};
  if (!db.meta.oauthStates) db.meta.oauthStates = {};
  db.meta.oauthStates[state] = { provider: 'google', ts: Date.now(), redirect };
  const scope = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly';
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(g.clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
  permissions.audit({ integration: 'google', action: 'oauth-start', status: 'ok', summary: 'oauth start' });
  return { ok: true, url, redirect, scopes: SCOPES.google };
}

async function oauthCallback(provider, query) {
  const p = String(provider || '').toLowerCase();
  if (p !== 'google') return { ok: false, error: 'unknown provider' };
  const code = query && query.code;
  const state = query && query.state;
  const db = dbm.load();
  const rec = db.meta && db.meta.oauthStates && db.meta.oauthStates[state];
  if (!rec) return { ok: false, error: 'invalid or expired OAuth state' };
  delete db.meta.oauthStates[state];
  const cfg = cfgm.load();
  const g = (cfg.connectors && cfg.connectors.google) || {};
  if (!g.clientId || !g.clientSecret) return { ok: false, error: 'Google client secret is not configured.' };
  if (!code) return { ok: false, error: 'missing code' };
  try {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: g.clientId, client_secret: g.clientSecret,
        redirect_uri: rec.redirect, grant_type: 'authorization_code'
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!json.refresh_token && !json.access_token) {
      permissions.audit({ integration: 'google', action: 'oauth-callback', status: 'error', summary: secrets.safeError(json.error_description || json.error || res.status) });
      return { ok: false, error: secrets.safeError(json.error_description || json.error || 'token exchange failed') };
    }
    await cfgm.save({
      connectors: {
        google: {
          enabled: true,
          refreshToken: json.refresh_token || g.refreshToken,
          accessToken: json.access_token || ''
        }
      }
    });
    clearExpired('google');
    permissions.audit({ integration: 'google', action: 'oauth-callback', status: 'ok', summary: 'authorized (token stored, not logged)' });
    return { ok: true };
  } catch (e) {
    permissions.audit({ integration: 'google', action: 'oauth-callback', status: 'error', summary: secrets.safeError(e) });
    return { ok: false, error: secrets.safeError(e) };
  }
}

function oauthStatus(provider) {
  const row = one(provider);
  if (!row) return { ok: false, error: 'unknown provider', status: 'unavailable' };
  return {
    ok: true,
    id: row.id,
    status: row.status,
    enabled: row.enabled,
    configured: row.configured,
    authorized: row.authorized,
    scopes: row.scopes || []
  };
}

async function revoke(id) {
  const key = String(id || '');
  const cfg = cfgm.load();
  if (key === 'google' || key === 'microsoft' || key === 'slack' || key === 'whatsapp' || key === 'demo') {
    const cur = (cfg.connectors && cfg.connectors[key]) || {};
    const cleared = { enabled: false };
    if (key === 'google') Object.assign(cleared, { accessToken: '', refreshToken: '', clientSecret: cur.clientSecret || '', clientId: cur.clientId || '' });
    if (key === 'microsoft') cleared.accessToken = '';
    if (key === 'slack') cleared.userToken = '';
    if (key === 'whatsapp') Object.assign(cleared, { accessToken: '', phoneNumberId: cur.phoneNumberId || '' });
    /* Explicit empty strings: we WANT to wipe secrets on revoke. Bypass preserve by saving non-blank dummy then blank? 
       preserveBlanks keeps blanks. So we must write a sentinel wipe.
       config.save preserves blanks — revoke needs a real clear. */
    await wipeConnectorSecrets(key, cleared);
    clearExpired(key);
  } else if (key === 'telegram') {
    await wipePath(['telegram'], { enabled: false, token: '', allowedChatId: (cfg.telegram && cfg.telegram.allowedChatId) || '' });
  } else if (key === 'smtp') {
    await wipePath(['smtp'], { ...(cfg.smtp || {}), pass: '' });
  } else if (key === 'sms') {
    await wipePath(['sms'], { enabled: false, bridgeUrl: (cfg.sms && cfg.sms.bridgeUrl) || '', token: '' });
  } else if (key === 'phone') {
    /* Genuinely clear the bridge token (blank saves normally preserve secrets — revoke must not). */
    await wipePath(['phone'], { enabled: false, bridgeToken: '', label: (cfg.phone && cfg.phone.label) || 'Android phone' });
  } else {
    return { ok: false, error: 'unknown integration' };
  }
  permissions.audit({ integration: key, action: 'revoke', status: 'ok', summary: 'credentials revoked' });
  return { ok: true, id: key, status: 'disabled' };
}

async function wipeConnectorSecrets(id, patch) {
  /* Directly mutate the in-memory cfg so blank values actually clear. */
  const cfg = cfgm.load();
  cfg.connectors = cfg.connectors || {};
  cfg.connectors[id] = { ...(cfg.connectors[id] || {}), ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (secrets.isSecretKey(k) && !String(v || '').trim()) cfg.connectors[id][k] = '';
  }
  try { await require('./store').docSet('settings', cfg); } catch (_) {}
}

async function wipePath(path, patch) {
  const cfg = cfgm.load();
  let cur = cfg;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] || (cur[path[i]] = {});
  const leaf = path[path.length - 1];
  cur[leaf] = { ...(cur[leaf] || {}), ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (secrets.isSecretKey(k) && !String(v || '').trim()) cur[leaf][k] = '';
  }
  try { await require('./store').docSet('settings', cfg); } catch (_) {}
}

/* ---- outbound transports (mocked in tests via _setFetch / _setTransport) ---- */
const transports = {};

function _setTransport(name, fn) {
  if (!fn) delete transports[name];
  else transports[name] = fn;
}

async function sendTelegram({ to, body }) {
  if (transports.telegram) return transports.telegram({ to, body });
  const cfg = cfgm.load();
  const tg = cfg.telegram || {};
  if (!tg.enabled || !tg.token) return { ok: false, error: 'Telegram is disabled or has no bot token.' };
  const chat = to || tg.allowedChatId;
  if (!chat) return { ok: false, error: 'No Telegram chat id. Set allowedChatId or pass a chat id.' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: body })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) return { ok: false, error: secrets.safeError(json.description || `Telegram ${res.status}`) };
    return { ok: true, providerId: String((json.result && json.result.message_id) || ''), confirmed: true };
  } catch (e) {
    return { ok: false, error: secrets.safeError(e) };
  }
}

async function sendWhatsApp({ to, body }) {
  if (transports.whatsapp) return transports.whatsapp({ to, body });
  const cfg = cfgm.load();
  const w = (cfg.connectors && cfg.connectors.whatsapp) || {};
  if (!w.enabled) return { ok: false, error: 'WhatsApp is disabled. Enable it in Settings after adding Cloud API credentials.' };
  if (!w.accessToken || !w.phoneNumberId) return { ok: false, error: 'WhatsApp Cloud API is not configured (need access token + phone number ID). ARIA will not scrape WhatsApp Web.' };
  const digits = String(to || '').replace(/[^\d+]/g, '');
  if (!digits) return { ok: false, error: 'WhatsApp needs a phone number in E.164 format.' };
  try {
    const res = await fetchImpl(`https://graph.facebook.com/v19.0/${w.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${w.accessToken}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits.replace(/^\+/, ''), type: 'text', text: { body } })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      if (res.status === 401) markExpired('whatsapp', json.error && json.error.message);
      return { ok: false, error: secrets.safeError((json.error && json.error.message) || `WhatsApp ${res.status}`) };
    }
    const mid = json.messages && json.messages[0] && json.messages[0].id;
    return { ok: true, providerId: String(mid || ''), confirmed: true };
  } catch (e) {
    return { ok: false, error: secrets.safeError(e) };
  }
}

async function sendSms({ to, body }) {
  if (transports.sms) return transports.sms({ to, body });
  const cfg = cfgm.load();
  const sms = cfg.sms || {};
  if (!sms.enabled || !sms.bridgeUrl) {
    return { ok: false, error: 'SMS device bridge is not configured. ARIA will not send SMS without an explicit local bridge.' };
  }
  try {
    const res = await fetchImpl(sms.bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sms.token ? { Authorization: `Bearer ${sms.token}` } : {}) },
      body: JSON.stringify({ to, body })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) return { ok: false, error: secrets.safeError(json.error || `SMS bridge ${res.status}`) };
    return { ok: true, providerId: String(json.id || json.providerId || ''), confirmed: true };
  } catch (e) {
    return { ok: false, error: secrets.safeError(e) };
  }
}

async function sendEmail({ to, subject, body }) {
  if (transports.email) return transports.email({ to, subject, body });
  const cfg = cfgm.load();
  const email = require('./email');
  if (typeof email.sendMail === 'function') {
    const r = await email.sendMail(cfg, { to, subject: subject || 'Message from ARIA', text: body });
    if (r && r.sent) return { ok: true, providerId: r.id || '', confirmed: true };
    return { ok: false, error: secrets.safeError((r && (r.error || r.skipped)) || 'email not sent') };
  }
  return { ok: false, error: 'SMTP is not configured.' };
}

function _reset() {
  fetchImpl = (...args) => fetch(...args);
  for (const k of Object.keys(transports)) delete transports[k];
}

module.exports = {
  status, one, classify, extraStatus, SCOPES,
  oauthStart, oauthCallback, oauthStatus, revoke,
  sendTelegram, sendWhatsApp, sendSms, sendEmail,
  markExpired, clearExpired,
  _setFetch, _setTransport, _reset
};
