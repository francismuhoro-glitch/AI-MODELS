'use strict';
/* Central secret handling — never leak credentials in GET responses, logs, chat,
   summaries, TTS or error messages. Blank saves must preserve the stored value. */

const SECRET_KEY_RE = /^(apiKey|pass|password|passwd|pwd|token|accessToken|refreshToken|clientSecret|userToken|privateKey|secret|bridgeToken|smtpPass)$/i;
const SECRET_KEY_HINT_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|secret)$/i;
const CONFIGURED_RE = /Configured$/;

function isSecretKey(key) {
  const k = String(key || '');
  if (!k || CONFIGURED_RE.test(k)) return false;
  if (SECRET_KEY_RE.test(k)) return true;
  if (SECRET_KEY_HINT_RE.test(k) && k !== 'tokenConfigured') return true;
  return false;
}

function isPresent(v) {
  return !(v === '' || v === null || v === undefined || (typeof v === 'string' && !String(v).trim()));
}

function clone(o) {
  return JSON.parse(JSON.stringify(o == null ? {} : o));
}

/* Walk `incoming` and, for any secret key whose value is blank, copy the current secret. */
function preserveBlanks(current, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const cur = current && typeof current === 'object' ? current : {};
  const out = { ...incoming };
  for (const [k, v] of Object.entries(out)) {
    if (isSecretKey(k)) {
      if (!isPresent(v) && isPresent(cur[k])) out[k] = cur[k];
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = preserveBlanks(cur[k], v);
    }
  }
  return out;
}

/* Return a deep clone with secret values blanked and `<key>Configured` flags set. */
function redactTree(value, original) {
  const src = original === undefined ? value : original;
  if (value == null) return value;
  if (Array.isArray(value)) {
    const srcArr = Array.isArray(src) ? src : [];
    return value.map((item, i) => redactTree(item, srcArr[i]));
  }
  if (typeof value !== 'object') return value;
  const out = {};
  const srcObj = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) {
      out[k] = typeof v === 'string' || v == null ? '' : (typeof v === 'object' ? redactTree(v, srcObj[k]) : v);
      out[k + 'Configured'] = isPresent(srcObj[k] !== undefined ? srcObj[k] : v);
    } else if (v && typeof v === 'object') {
      out[k] = redactTree(v, srcObj[k]);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactText(text) {
  return String(text || '')
    .replace(/\b(?:sk|pk|rk|ghp|gho|glpat|xox[pboa]|npm)[-_](?:live|test|pub)?[-_]?[A-Za-z0-9_-]{6,}\b/gi, '[redacted]')
    .replace(/\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)\b(?:\s+is|:|=)?\s*[\w.+/=-]{4,}/gi, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => m); // emails in errors stay; credentials do not
}

function safeError(e) {
  const m = (e && e.message) ? e.message : String(e || 'error');
  return redactText(m).slice(0, 240);
}

function containsSecret(haystack, secret) {
  const h = typeof haystack === 'string' ? haystack : JSON.stringify(haystack || '');
  const s = String(secret || '');
  return !!(s && h.includes(s));
}

/* Recursively collect every secret string currently stored (for leak tests). */
function collectSecrets(obj, into = []) {
  if (!obj || typeof obj !== 'object') return into;
  if (Array.isArray(obj)) { for (const x of obj) collectSecrets(x, into); return into; }
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretKey(k) && typeof v === 'string' && v.trim()) into.push(v.trim());
    else if (v && typeof v === 'object') collectSecrets(v, into);
  }
  return into;
}

module.exports = {
  isSecretKey, isPresent, preserveBlanks, redactTree, redactText, safeError,
  containsSecret, collectSecrets, clone
};
