'use strict';
/* Microsoft connector — Outlook Mail + Calendar via Microsoft Graph.
   Setup: azure portal → App registration → delegated scopes Mail.Read, Calendars.Read
   → get an access token (device code flow is easiest for personal use) → paste it in Settings. */

async function sync(ctx) {
  const { db, cfg } = ctx;
  const token = cfg.connectors.microsoft.accessToken;
  if (!token) return { skipped: 'paste a Microsoft Graph access token in Settings → Connectors' };
  const H = { Authorization: `Bearer ${token}` };
  const nowIso = new Date(Date.now() - 3 * 864e5).toISOString();
  const nextIso = new Date(Date.now() + 7 * 864e5).toISOString();
  const counts = { emails: 0, events: 0 };

  const mail = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$top=25&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,from,receivedDateTime,isRead`, { headers: H });
  if (mail.ok) {
    const data = await mail.json();
    for (const m of data.value || []) {
      db.upsert('emails', {
        id: `outlook-${m.id.slice(0, 40)}`, source: 'outlook', from: m.from?.emailAddress?.address || '',
        fromName: m.from?.emailAddress?.name || '', subject: m.subject || '(no subject)',
        body: m.bodyPreview || '', snippet: (m.bodyPreview || '').slice(0, 200),
        receivedAt: new Date(m.receivedDateTime).getTime(), read: !!m.isRead, labels: []
      });
      counts.emails++;
    }
  } else if (mail.status === 401) return { error: 'Microsoft token expired — get a fresh one (device code flow) and update Settings.' };

  const cal = await fetch(`https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${nowIso}&endDateTime=${nextIso}&$top=50&$select=id,subject,start,end,location,attendees`, { headers: H });
  if (cal.ok) {
    const data = await cal.json();
    for (const ev of data.value || []) {
      db.upsert('events', {
        id: `outlook-ev-${ev.id.slice(0, 40)}`, source: 'microsoft', calendar: 'Work',
        title: ev.subject || '(untitled)', start: new Date(ev.start?.dateTime + 'Z').getTime(),
        end: new Date(ev.end?.dateTime + 'Z').getTime(), location: ev.location?.displayName || '',
        attendees: (ev.attendees || []).map(a => a.emailAddress?.address), notes: ''
      });
      counts.events++;
    }
  }
  return counts;
}

module.exports = { name: 'microsoft', label: 'Outlook Mail + Calendar', sync };
