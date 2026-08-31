'use strict';
/* Connector registry + sync orchestrator */
const dbm = require('../db');
const cfgm = require('../config');

const demo = require('./demo');
const slack = require('./slack');
const google = require('./google');
const microsoft = require('./microsoft');
const whatsapp = require('./whatsapp');

const ALL = [demo, google, microsoft, slack, whatsapp];

function status() {
  const cfg = cfgm.load();
  return ALL.map(c => {
    const conf = cfg.connectors[c.name] || {};
    const enabled = !!conf.enabled;
    const configured = c.name === 'demo' ? true :
      c.name === 'slack' ? !!conf.userToken :
      c.name === 'google' ? !!(conf.refreshToken && conf.clientId) :
      c.name === 'microsoft' ? !!conf.accessToken :
      c.name === 'whatsapp' ? !!(conf.accessToken && conf.phoneNumberId) : false;
    return { id: c.name, label: c.label, enabled, configured, setupRequired: c.name !== 'demo' && !configured };
  });
}

async function syncAll() {
  const db = dbm.load();
  const cfg = cfgm.load();
  const results = {};
  for (const c of ALL) {
    const conf = cfg.connectors[c.name] || {};
    if (!conf.enabled) { results[c.name] = { skipped: 'disabled' }; continue; }
    try { results[c.name] = await c.sync({ db, cfg }); }
    catch (e) { results[c.name] = { error: e.message }; }
  }
  // Stamp context (work vs business) + priority on fresh items
  const { classifyContext, scorePriority, priorityOf } = require('../util');
  for (const col of ['emails', 'messages']) {
    for (const item of db.find(col)) {
      if (!item.context) item.context = classifyContext(item);
      if (!item.priority) { const s = scorePriority(item); item.priorityScore = s; item.priority = priorityOf(s); }
      db.upsert(col, item);
    }
  }
  dbm.load().meta.lastSync = Date.now();
  await dbm.saveNow();
  const brain = require('../brain');
  brain.autoGrow();          // second brain learns from everything synced
  await dbm.saveNow();
  return { ok: true, results, lastSync: dbm.load().meta.lastSync };
}

module.exports = { ALL, status, syncAll };
