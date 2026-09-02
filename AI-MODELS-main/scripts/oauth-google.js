'use strict';
/* One-time Google OAuth helper — run:  npm run oauth:google
   Prints an auth URL → open it → approve → this catches the redirect and prints
   the clientId / clientSecret / refreshToken to paste into Settings → Connectors → Google. */
const http = require('http');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

(async () => {
  const clientId = await ask('Google OAuth Client ID: ');
  const clientSecret = await ask('Google OAuth Client Secret: ');
  const redirect = 'http://localhost:3111/oauth/google';
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly')}&access_type=offline&prompt=consent`;
  console.log(`\n1) Open this URL in your browser:\n\n${url}\n`);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== '/oauth/google') { res.end('waiting…'); return; }
    const code = u.searchParams.get('code');
    res.end('<h2>ARIA OS — authorized ✅ You can close this tab.</h2>');
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' })
    }).then(r => r.json());
    console.log('\n2) Paste these into ARIA OS → Settings → Connectors → Google:\n');
    console.log(`   clientId:     ${clientId}`);
    console.log(`   clientSecret: ${clientSecret}`);
    console.log(`   refreshToken: ${tok.refresh_token || '(none returned — revoke the app at myaccount.google.com/permissions and retry)'}`);
    server.close(); process.exit(0);
  }).listen(3111, () => console.log('3) Waiting for the OAuth redirect on http://localhost:3111 …\n'));
})();
