'use strict';
/* Slack connector — real, works with a User Token (xoxp-...) with conversations:history + channels:read scopes.
   Create one at https://api.slack.com/apps → OAuth & Permissions. */

async function slackGet(token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

async function fetchChannels(token, db) {
  const chans = [];
  for (const types of ['public_channel,private_channel', 'im']) {
    const r = await slackGet(token, 'conversations.list', { types, limit: 100 });
    chans.push(...r.channels || []);
  }
  return chans;
}

async function sync(ctx) {
  const { db, cfg } = ctx;
  const token = cfg.connectors.slack.userToken;
  if (!token) return { skipped: 'add a Slack user token in Settings → Connectors' };
  const channels = await fetchChannels(token, db);
  let count = 0;
  for (const ch of channels.slice(0, 25)) {
    if ((ch.messages_count || 0) === 0 && ch.is_im) continue;
    const hist = await slackGet(token, 'conversations.history', { channel: ch.id, limit: 25 });
    for (const m of hist.messages || []) {
      if (m.subtype && m.subtype !== 'bot_message') continue;
      const label = ch.is_im ? `DM — ${ch.user || 'user'}` : `#${ch.name}`;
      db.upsert('messages', {
        id: `slack-${m.ts.replace('.', '-')}`, source: 'slack', channel: label,
        from: m.user || 'bot', text: m.text || '', sentAt: (+m.ts) * 1000, read: false
      });
      count++;
    }
  }
  return { synced: count, channels: channels.length };
}

module.exports = { name: 'slack', label: 'Slack', sync };
