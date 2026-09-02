'use strict';
/* Long-lived server entry — run this on a PC, VPS, Raspberry Pi or home server.
   (Serverless/Vercel uses api/index.js + vercel.json instead.) */
const { app, init } = require('./app');
const scheduler = require('./scheduler');
const cfgm = require('./config');

const PORT = process.env.PORT || 3000;

(async () => {
  await init();
  // In-process schedules: morning brief + 30-min sync heartbeat. Re-armed when settings change.
  scheduler.start();
  app.set('rearm', () => scheduler.start());
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ARIA OS running → http://0.0.0.0:${PORT}  (brief daily at ${cfgm.load().wakeTime} ${cfgm.load().owner.timezone})`);
  });
})();
