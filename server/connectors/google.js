'use strict';
/* Google connector — Gmail + Google Calendar.
   Setup (one-time, ~10 min, instructions mirrored in Settings UI):
   1. console.cloud.google.com → new project → enable Gmail API + Google Calendar API
   2. OAuth consent screen → External → add yourself as test user
   3. Credentials → OAuth Client ID → Web app → redirect URI: http://localhost:3111/oauth/google
   4. Run:  npm run oauth:google  (helper prints an auth URL, exchanges code for a refresh token)
   5. Paste clientId + clientSecret + refreshToken in Settings → Connectors → Google. */

function authHeader(cfg) {
  return { Authorization: `Bearer ${cfg.connectors.google.accessToken || ''}` };
}

async function refreshToken(cfg) {
  const g = cfg.connectors.google;
  if (!g.refreshToken || !g.clientId || !g.clientSecret) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' })
  });
  const json = await res.json();
  if (json.access_token) { g.accessToken = json.access_token; return json.access_token; }
  throw new Error(`Google token refresh failed: ${json.error_description || json.error}`);
}

async function sync(ctx) {
  const { db, cfg } = ctx;
  const g = cfg.connectors.google;
  if (!g.clientId || !g.refreshToken) return { skipped: 'complete Google OAuth setup in Settings → Connectors' };
  await refreshToken(cfg);
  const now = new Date(), weekAgo = new Date(Date.now() - 3 * 864e5), weekNext = new Date(Date.now() + 7 * 864e5);
  let counts = { events: 0, emails: 0 };

  // Calendar
  const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${weekAgo.toISOString()}&timeMax=${weekNext.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100`, { headers: authHeader(cfg) });
  if (calRes.ok) {
    const data = await calRes.json();
    for (const ev of data.items || []) {
      db.upsert('events', {
        id: `gcal-${ev.id}`, source: 'google', calendar: ev.organizer?.self ? 'Work' : 'Work',
        title: ev.summary || '(untitled)', start: new Date(ev.start?.dateTime || ev.start?.date).getTime(),
        end: new Date(ev.end?.dateTime || ev.end?.date).getTime(), location: ev.location || '',
        attendees: (ev.attendees || []).map(a => a.email), notes: ev.description || ''
      });
      counts.events++;
    }
  }

  // Gmail (last 3 days)
  const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=newer_than%3A3d', { headers: authHeader(cfg) });
  if (gmailRes.ok) {
    const list = await gmailRes.json();
    for (const m of (list.messages || []).slice(0, 30)) {
      const full = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers: authHeader(cfg) });
      if (!full.ok) continue;
      const d = await full.json();
      const hdr = (name) => (d.payload?.headers || []).find(h => h.name === name)?.value || '';
      const fromMatch = (hdr('From')).match(/^(.*?)\s*<(.+)>$/) || ['', hdr('From'), hdr('From')];
      const bodyData = d.snippet || '';
      db.upsert('emails', {
        id: `gmail-${d.id}`, source: 'gmail', from: fromMatch[2], fromName: fromMatch[1].replace(/"/g, '') || fromMatch[2],
        subject: hdr('Subject') || '(no subject)', body: bodyData, snippet: bodyData.slice(0, 200),
        receivedAt: +d.internalDate, read: !(d.labelIds || []).includes('UNREAD'), labels: d.labelIds || []
      });
      counts.emails++;
    }
  }
  return counts;
}

module.exports = { name: 'google', label: 'Gmail + Google Calendar', sync };
