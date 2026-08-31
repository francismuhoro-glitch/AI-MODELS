'use strict';
/* Backing store adapter — TWO modes, chosen by environment:
   1. Local files (default): data/state.json, data/settings.json, data/vapid.json
   2. Supabase Postgres (when SUPABASE_URL + SUPABASE_SERVICE_KEY are set):
      a single aria_docs table, one JSONB row per document.
      Needed for serverless hosting (Vercel) where the filesystem is ephemeral.
   Zero extra dependencies — talks to Supabase's REST (PostgREST) API via fetch. */
const fs = require('fs');
const path = require('path');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const TABLE = 'aria_docs';

const isRemote = () => !!(SUPA_URL && SUPA_KEY);
const dataDir = () => process.env.ARIA_DATA_DIR
  || (process.env.VERCEL ? '/tmp/aria-data' /* serverless: filesystem is ephemeral & read-only outside /tmp */
    : path.join(__dirname, '..', 'data'));

function filePath(id) { return path.join(dataDir(), `${id}.json`); }

/* Sync read — only valid in local-file mode (used by db.load()'s lazy fallback). */
function docGetSync(id) {
  try { return JSON.parse(fs.readFileSync(filePath(id), 'utf8')); }
  catch (_) { return null; }
}

function headers() {
  return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
}

async function docGet(id) {
  if (!isRemote()) {
    try { return JSON.parse(fs.readFileSync(filePath(id), 'utf8')); }
    catch (_) { return null; }
  }
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?select=data&id=eq.${encodeURIComponent(id)}`, { headers: headers() });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? rows[0].data : null;
  } catch (_) { return null; }
}

async function docSet(id, data) {
  if (!isRemote()) {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(filePath(id), JSON.stringify(data, null, 2));
    return;
  }
  const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?on_conflict=id`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ id, data, updated_at: new Date().toISOString() }])
  });
  if (!res.ok) throw new Error(`Supabase write failed (${res.status}): ${await res.text().catch(() => '')}`.slice(0, 300));
}

module.exports = { docGet, docGetSync, docSet, isRemote, dataDir };
