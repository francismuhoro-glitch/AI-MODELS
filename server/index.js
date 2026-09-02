'use strict';
/* Long-lived server entry — run this on a PC, VPS, Raspberry Pi or home server.
   (Serverless/Vercel uses api/index.js + vercel.json instead.) */
const app = require('./app');
const scheduler = require('./scheduler');
const cfgm = require('./config');

const PORT = process.env.PORT || 3000;

(async () => {
  await app.init();
  const cfg = cfgm.load();
  // In-process schedules: morning brief + 30-min sync heartbeat. Re-armed when settings change.
  try {
    scheduler.start();
    app.set('rearm', () => { try { scheduler.start(); } catch (e) { console.error('[scheduler]', e.message); } });
  } catch (e) { console.error('[scheduler] disabled:', e.message); }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ARIA OS running → http://0.0.0.0:${PORT}  (brief daily at ${cfg.wakeTime} ${cfg.owner.timezone})`);
  });
})();
