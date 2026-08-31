'use strict';
/* Web Push — delivers the morning brief to installed phones/desktops (lock-screen notifications).
   VAPID keys are generated once and stored in data/vapid.json. */
const fs = require('fs');
const path = require('path');
const cfgm = require('./config');

let webpush = null;
try { webpush = require('web-push'); } catch (_) {}

const VAPID_FILE = path.join(cfgm.DATA_DIR, 'vapid.json');

function vapid() {
  if (!webpush) return null;
  try { return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); }
  catch (_) {
    try {
      const keys = webpush.generateVAPIDKeys();
      fs.mkdirSync(cfgm.DATA_DIR, { recursive: true });
      fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
      return keys;
    } catch (_) { return null; }
  }
}

async function pushAll(payload) {
  const v = vapid();
  if (!webpush || !v) return { skipped: 'web-push unavailable' };
  const dbm = require('./db');
  const db = dbm.load();
  const subs = db.subscriptions || [];
  let sent = 0, pruned = 0;
  await Promise.all(subs.map(async (sub) => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject: 'mailto:aria@local', publicKey: v.publicKey, privateKey: v.privateKey } }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subscriptions = (db.subscriptions || []).filter(s => s.endpoint !== sub.endpoint);
        dbm.save(); pruned++;
      }
    }
  }));
  return { sent, pruned };
}

module.exports = { pushAll, vapid };
