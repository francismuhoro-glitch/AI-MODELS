'use strict';
/* Scheduler — the OS heartbeat: morning brief at wake time, connectors every 30 min. */
const cron = require('node-cron');
const cfgm = require('./config');
const connectors = require('./connectors');
const briefGen = require('./brief');
const { dayKey, tzDate } = require('./util');

let jobs = [];

function start() {
  stop();
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone;

  // Morning brief at wake time, every day
  const [hh, mm] = (cfg.wakeTime || '06:00').split(':').map(Number);
  jobs.push(cron.schedule(`${mm} ${hh} * * *`, async () => {
    try {
      await connectors.syncAll();
      const brief = await briefGen.generate({ trigger: 'scheduled' });
      console.log(`[scheduler] morning brief generated for ${brief.date} (engine trigger)`);
    } catch (e) { console.error('[scheduler] brief failed:', e.message); }
  }, { timezone: tz }));

  // Sync heartbeat: every 30 minutes
  jobs.push(cron.schedule('*/30 * * * *', async () => {
    try { await connectors.syncAll(); console.log('[scheduler] connectors synced'); }
    catch (e) { console.error('[scheduler] sync failed:', e.message); }
  }, { timezone: tz }));

  // Alarm / reminder tick: fire due browser-notification jobs (never a device alarm).
  jobs.push(cron.schedule('* * * * *', async () => {
    try {
      const alarms = require('./alarms');
      const r = await alarms.tick();
      if (r.fired) console.log(`[scheduler] fired ${r.fired} alarm(s) via browser notification / web push`);
    } catch (e) { console.error('[scheduler] alarm tick failed:', e.message); }
  }, { timezone: tz }));

  // Memory hygiene + durable learning: drain anything the reply path queued but did not finish
  // (serverless freezes, a crash mid-extraction), then expire stale low-importance memories.
  jobs.push(cron.schedule('7 * * * *', async () => {
    try {
      const learning = require('./learning');
      const learned = await learning.flush();
      if (learned.processed) console.log(`[scheduler] learning: ${learned.saved} saved, ${learned.merged} merged, ${learned.superseded} superseded`);
      const memory = require('./memory');
      const r = await memory.expireStale();
      if (r.expired) console.log(`[scheduler] expired ${r.expired} stale memory item(s)`);
    } catch (e) { console.error('[scheduler] memory sweep failed:', e.message); }
  }, { timezone: tz }));

  console.log(`[scheduler] started — brief at ${cfg.wakeTime} ${tz}, sync every 30 min, memory sweep hourly`);

  // Catch-up: if it's already past wake time today and no brief exists yet → generate now
  catchUp();
}

function catchUp() {
  const cfg = cfgm.load();
  const tz = cfg.owner.timezone;
  const today = dayKey(Date.now(), tz);
  const db = require('./db').load();
  const hasToday = db.find('briefs', b => b.date === today && b.trigger === 'scheduled').length > 0;
  const p = tzDate(Date.now(), tz);
  const nowMin = (+p.hour) * 60 + (+p.minute);
  const [wh, wm] = (cfg.wakeTime || '06:00').split(':').map(Number);
  if (!hasToday && nowMin >= wh * 60 + wm) {
    (async () => {
      try {
        await connectors.syncAll();
        await briefGen.generate({ trigger: 'scheduled' });
        console.log('[scheduler] catch-up brief generated');
      } catch (e) { console.error('[scheduler] catch-up failed:', e.message); }
    })();
  }
}

function stop() { for (const j of jobs) try { j.stop(); } catch (_) {} jobs = []; }

module.exports = { start, stop };
