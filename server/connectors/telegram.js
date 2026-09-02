'use strict';
const cfgm = require('../config');

let polling = false;

function startTelegram() {
  // Never run infinite polling loop on Vercel serverless functions
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const cfg = cfgm.load();
  const tg = cfg.telegram || {};
  if (tg.enabled && tg.token && !polling) {
    polling = true;
    console.log('✈️ Telegram Bot listener active');
  }
}

function stopTelegram() {
  polling = false;
}

module.exports = { startTelegram, stopTelegram };
