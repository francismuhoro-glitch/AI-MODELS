'use strict';
/* Web Push — delivers the morning brief to installed phones/desktops (lock-screen notifications).
   VAPID keys: env vars first (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — required on serverless),
   otherwise generated once and stored in the backing store. */
const store = require('./store');

let webpush = null;
try { webpush = require('web-push'); } catch (_) {}

async function vapid() {
  if (!webpush) return null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  let v = await store.docGet('vapid');
  if (!v) {
    try { v = webpush.generateVAPIDKeys(); await store.docSet('vapid', v); }
    catch (_) { return null; }
  }
  return v;
}

async function pushAll(payload) {
  const v = await vapid();
  if (!webpush || !v) return { skipped: 'web-push unavailable' };
  const dbm = require('./db');
  const subs = dbm.load().subscriptions || [];
  let sent = 0, pruned = 0;
  await Promise.all(subs.map(async (sub) => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject: 'mailto:aria@local', publicKey: v.publicKey, privateKey: v.privateKey } }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        const db = dbm.load();
        db.subscriptions = (db.subscriptions || []).filter(s => s.endpoint !== sub.endpoint);
        await dbm.saveNow(); pruned++;
      }
    }
  }));
  return { sent, pruned };
}

module.exports = { pushAll, vapid };
