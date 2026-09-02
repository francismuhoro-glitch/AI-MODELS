'use strict';
/* WhatsApp connector — Meta Cloud API (business).
   Setup: developers.facebook.com → create app → add WhatsApp product → get token + phone number ID
   → paste in Settings. Also supports inbound pushes: point the Meta webhook at
   https://your-host/api/ingest/whatsapp  (GET verify + POST receive are handled by the server). */

async function sync(ctx) {
  const { db, cfg } = ctx;
  const { accessToken, phoneNumberId } = cfg.connectors.whatsapp;
  if (!accessToken || !phoneNumberId) return { skipped: 'add WhatsApp Cloud API credentials in Settings → Connectors' };
  const H = { Authorization: `Bearer ${accessToken}` };
  // Conversations list → last messages
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/conversations?platform=web&access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) return { error: `WhatsApp Cloud API: ${res.status} — check token/permissions (whatsapp_business_messaging)` };
  const data = await res.json();
  let count = 0;
  for (const conv of (data.data || []).slice(0, 15)) {
    const msgs = await fetch(`https://graph.facebook.com/v19.0/${conv.id}/messages?access_token=${encodeURIComponent(accessToken)}`).then(r => r.ok ? r.json() : { data: [] });
    for (const m of (msgs.data || []).slice(0, 10)) {
      db.upsert('messages', {
        id: `wa-${m.id}`, source: 'whatsapp', channel: conv.name || 'WhatsApp',
        from: m.from || conv.name || 'unknown', text: m.text?.body || '', sentAt: +(m.timestamp || 0) * 1000, read: false
      });
      count++;
    }
  }
  return { synced: count };
}

module.exports = { name: 'whatsapp', label: 'WhatsApp Business', sync };
