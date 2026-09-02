'use strict';
const cfgm = require('../config');
const dbm = require('../db');
const assistant = require('../assistant');

let polling = false;
let lastUpdateId = 0;

async function sendTelegram(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

async function pollUpdates() {
  if (!polling) return;
  const cfg = cfgm.load();
  const tg = cfg.telegram || {};
  if (!tg.enabled || !tg.token) {
    polling = false;
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`, {
      signal: AbortSignal.timeout(25000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          const msg = update.message;
          if (!msg || !msg.text) continue;

          // Auth check
          if (tg.allowedChatId && String(msg.chat.id) !== String(tg.allowedChatId)) {
            await sendTelegram(tg.token, msg.chat.id, '⛔ Unauthorized. Configure your Telegram Chat ID in ARIA Settings.');
            continue;
          }

          const query = msg.text.trim();
          if (query === '/start') {
            await sendTelegram(tg.token, msg.chat.id, `👑 *ARIA Executive Assistant connected*\nChat ID: `${msg.chat.id}`\nAsk me anything, teach me with "remember that...", or ask about your day.`);
            continue;
          }

          const replyObj = await assistant.respond(query);
          await sendTelegram(tg.token, msg.chat.id, replyObj.reply);
        }
      }
    }
  } catch (_) {}
  
  if (polling) setTimeout(pollUpdates, 1500);
}

function startTelegram() {
  const cfg = cfgm.load();
  const tg = cfg.telegram || {};
  if (tg.enabled && tg.token && !polling) {
    polling = true;
    pollUpdates();
    console.log('✈️ Telegram Bot listener active');
  }
}

function stopTelegram() {
  polling = false;
}

module.exports = { startTelegram, stopTelegram, sendTelegram };
