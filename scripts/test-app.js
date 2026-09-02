'use strict';
/* ARIA verification suite — no test framework, just node scripts/test-app.js
   1. API contract: every endpoint answers 200 with the expected JSON shape.
   2. Frontend: boots public/index.html + public/js/app.js in jsdom against the real
      server and renders every tab, failing on ANY console error or unhandled rejection. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

process.env.ARIA_DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aria-test-'));

const app = require('../server/app');

let pass = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  await app.init();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (p) => { const r = await fetch(base + p); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, json: j }; };
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, json: j };
  };

  console.log('\n[1] API contract');
  const state = await get('/api/state');
  check('GET /api/state → 200', state.status === 200, 'got ' + state.status);
  const s = state.json || {};
  for (const k of ['engine', 'owner', 'rhythm', 'cfg', 'stats', 'counts']) {
    check(`/api/state has object "${k}"`, s[k] && typeof s[k] === 'object');
  }
  check('/api/state.engine.activeEngine is a string', typeof (s.engine || {}).activeEngine === 'string');
  check('/api/state.stats.engine is a string', typeof (s.stats || {}).engine === 'string');
  for (const k of ['events', 'emails', 'inbox', 'messages', 'notes', 'chats', 'tasks', 'briefs']) {
    check(`/api/state.${k} is an array`, Array.isArray(s[k]), typeof s[k]);
  }
  check('/api/state.timezone present', typeof s.timezone === 'string' && s.timezone.length > 0);

  for (const p of ['/api/emails', '/api/events', '/api/inbox', '/api/tasks', '/api/messages', '/api/notes', '/api/briefs', '/api/connectors', '/api/assistant/history', '/api/search?q=aria']) {
    const r = await get(p);
    check(`GET ${p} → 200 array`, r.status === 200 && Array.isArray(r.json), `status ${r.status}, type ${Array.isArray(r.json) ? 'array' : typeof r.json}`);
  }
  for (const p of ['/api/settings', '/api/config', '/api/ai/status', '/api/health', '/api/push/key']) {
    const r = await get(p);
    check(`GET ${p} → 200 object`, r.status === 200 && r.json && typeof r.json === 'object', 'status ' + r.status);
  }

  // Dual mount: the same routes must resolve WITHOUT the /api prefix (Vercel rewrite shape).
  for (const p of ['/state', '/emails', '/events', '/inbox']) {
    const r = await get(p);
    check(`GET ${p} (unprefixed) → 200`, r.status === 200 && r.json !== null, 'status ' + r.status);
  }

  console.log('\n[2] Mutations');
  const task = await post('/api/inbox', { title: 'Verification task', priority: 'high' });
  check('POST /api/inbox → 200 with id', task.status === 200 && !!(task.json || {}).id);
  const afterTask = await get('/api/inbox');
  check('new task visible in /api/inbox', (afterTask.json || []).some(t => t.id === task.json.id));
  const ev = await post('/api/events', { title: 'Verification event', start: Date.now() + 3600000 });
  check('POST /api/events → 200 with id', ev.status === 200 && !!(ev.json || {}).id);
  const asst = await post('/api/assistant', { message: 'what are my priorities?' });
  check('POST /api/assistant → 200 with reply', asst.status === 200 && typeof (asst.json || {}).reply === 'string');
  const hist = await get('/api/assistant/history');
  check('assistant history is an array', Array.isArray(hist.json) && hist.json.length >= 2);
  const note = await post('/api/notes', { title: 'Verification note', content: 'ARIA remembers this.' });
  check('POST /api/notes → 200 with id', note.status === 200 && !!(note.json || {}).id);

  console.log('\n[3] Frontend render (jsdom)');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: base + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: undefined
  });
  const w = dom.window;
  w.fetch = (input, init) => fetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init);
  w.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.scrollTo = () => {};
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  if (!w.Notification) w.Notification = { permission: 'default', requestPermission: () => Promise.resolve('denied') };

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  try { w.eval(appJs); } catch (e) { errors.push('app.js threw: ' + e.message); }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(600);

  const views = ['hub', 'briefs', 'calendar', 'inbox', 'messages', 'brain', 'assistant', 'settings'];
  for (const v of views) {
    w.location.hash = '#/' + v;
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    await sleep(450);
    const main = w.document.getElementById('main');
    const txt = (main && main.innerHTML) || '';
    const rendered = txt.length > 0 && !txt.includes('loading…') && !txt.includes('⚠️');
    check(`view "${v}" renders`, rendered, txt.slice(0, 120).replace(/\s+/g, ' '));
  }
  const chip = w.document.getElementById('engine-chip');
  check('sidebar engine chip updated', /engine|LLM/i.test((chip && chip.textContent) || ''), (chip && chip.textContent) || '');
  check('no console errors during render', errors.length === 0, errors.slice(0, 5).join(' | '));

  dom.window.close();
  server.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach(f => console.log(' FAIL: ' + f)); process.exit(1); }
  console.log('All checks passed ✅');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
