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
  for (const k of ['events', 'emails', 'inbox', 'messages', 'notes', 'chats', 'tasks', 'briefs', 'agencyRuns', 'agents']) {
    check(`/api/state.${k} is an array`, Array.isArray(s[k]), typeof s[k]);
  }
  check('/api/state.timezone present', typeof s.timezone === 'string' && s.timezone.length > 0);

  for (const p of ['/api/emails', '/api/events', '/api/inbox', '/api/tasks', '/api/messages', '/api/notes', '/api/briefs', '/api/connectors', '/api/assistant/history', '/api/search?q=aria', '/api/agency/agents', '/api/agency/runs']) {
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

  console.log('\n[3] Agency swarm (multi-agent)');
  const roster = await get('/api/agency/agents');
  const rosterIds = (roster.json || []).map(a => a.id);
  check('GET /api/agency/agents → 200 array', roster.status === 200 && Array.isArray(roster.json));
  for (const id of ['director', 'researcher', 'copywriter', 'analyst']) {
    check(`roster contains ${id}`, rosterIds.includes(id), rosterIds.join(','));
  }
  check('every agent card has name + role + description',
    (roster.json || []).every(a => a && typeof a.name === 'string' && a.name && typeof a.role === 'string' && typeof a.description === 'string'));

  const planned = await post('/api/agency/plan', { task: 'Analyze all supplier notes and draft an executive briefing' });
  check('POST /api/agency/plan → 200', planned.status === 200 && !!(planned.json || {}).ok);
  check('plan decomposes the multi-step instruction', ((planned.json || {}).subtasks || []).length >= 2, JSON.stringify((planned.json || {}).subtasks));
  check('plan delegates to specialists', ((planned.json || {}).agents || []).length >= 1, JSON.stringify((planned.json || {}).agents));

  const mission = await post('/api/agency/run', { task: 'Analyze all supplier notes and draft an executive briefing' });
  const m = mission.json || {};
  check('POST /api/agency/run → 200', mission.status === 200, 'got ' + mission.status);
  check('run returns a non-empty finalOutput string', typeof m.finalOutput === 'string' && m.finalOutput.length > 80, typeof m.finalOutput);
  check('run returns an agentTrace array', Array.isArray(m.agentTrace) && m.agentTrace.length >= 3, `len ${(m.agentTrace || []).length}`);
  check('every trace step is { agent, action, result }',
    (m.agentTrace || []).every(t => t && typeof t.agent === 'string' && t.agent && typeof t.action === 'string' && t.action && typeof t.result === 'string'));
  const traceIds = (m.agentTrace || []).map(t => t.agentId);
  check('DirectorAgent opens and closes the mission', traceIds[0] === 'director' && traceIds[traceIds.length - 1] === 'director', traceIds.join('>'));
  for (const id of ['researcher', 'analyst', 'copywriter']) {
    check(`${id} executed in the swarm`, traceIds.includes(id), traceIds.join('>'));
  }
  check('final output is the Director synthesis', /Agency mission report/i.test(m.finalOutput || ''));
  check('final output carries the analysis + next actions', /Recommended next actions/i.test(m.finalOutput || '') && /Executive summary/i.test(m.finalOutput || ''));
  check('every trace step reports a duration', (m.agentTrace || []).every(t => typeof t.ms === 'number' && t.ms >= 0));

  const solo = await post('/api/agency/run', { task: 'Draft a customer proposal for the Kamau supplier order', agents: ['copywriter'] });
  const soloIds = ((solo.json || {}).agentTrace || []).map(t => t.agentId);
  check('explicit agents[] is honoured', solo.status === 200 && soloIds.includes('copywriter') && !soloIds.includes('researcher'), soloIds.join('>'));

  const parallel = await post('/api/agency/run', { task: 'Scan my inbox and priorities, then write my daily summary', mode: 'parallel' });
  check('parallel mode runs the full swarm', parallel.status === 200 && (parallel.json || {}).mode === 'parallel' && ((parallel.json || {}).agentTrace || []).length >= 4);

  const bad = await post('/api/agency/run', { task: '   ' });
  check('POST /api/agency/run with no task → 400', bad.status === 400, 'got ' + bad.status);

  const runs = await get('/api/agency/runs');
  check('GET /api/agency/runs lists the missions', Array.isArray(runs.json) && runs.json.length >= 3, `len ${(runs.json || []).length}`);
  const oneRun = await get('/api/agency/runs/' + encodeURIComponent(m.id));
  check('GET /api/agency/runs/:id returns the mission', oneRun.status === 200 && (oneRun.json || {}).id === m.id);
  const stateAfter = await get('/api/state');
  check('/api/state.agencyRuns tracks the missions', Array.isArray((stateAfter.json || {}).agencyRuns) && stateAfter.json.agencyRuns.length >= 3);
  const brainHit = await get('/api/search?q=' + encodeURIComponent('Agency mission supplier'));
  check('mission report is written into the second brain', Array.isArray(brainHit.json) && brainHit.json.some(h => /Agency mission/i.test(h.title || '')));

  console.log('\n[4] Frontend render (jsdom)');
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

  const views = ['hub', 'briefs', 'calendar', 'inbox', 'messages', 'brain', 'assistant', 'agency', 'settings'];
  for (const v of views) {
    w.location.hash = '#/' + v;
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    await sleep(450);
    const main = w.document.getElementById('main');
    const txt = (main && main.innerHTML) || '';
    const rendered = txt.length > 0 && !txt.includes('loading…') && !txt.includes('⚠️');
    check(`view "${v}" renders`, rendered, txt.slice(0, 120).replace(/\s+/g, ' '));
  }
  console.log('\n[5] Agency Swarm UI + voice loop');
  /* Assistant view: the two-way voice loop hangs off #asst-mic and a [data-voice-input] field. */
  w.location.hash = '#/assistant';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  await sleep(500);
  check('assistant exposes the #asst-mic button', !!w.document.getElementById('asst-mic'));
  check('assistant text field is the voice input', !!w.document.querySelector('#chat-in[data-voice-input]'));
  const speech = w.AriaSpeech;
  check('Speech engine is exported for the voice loop', !!speech && typeof speech.speak === 'function' && typeof speech.finalize === 'function');
  check('Speech resolves the active mic + input', !!speech && speech.micEl() === w.document.getElementById('asst-mic') && speech.inputEl() === w.document.getElementById('chat-in'));
  check('wake-word listener is mic/speech aware', !!w.AriaWakeWord && typeof w.AriaWakeWord.busy === 'function' && w.AriaWakeWord.busy() === false);
  /* A spoken transcript must land in the chat and post to the assistant, exactly like typing. */
  let spoke = null;
  speech.speak = (t) => { spoke = t; return Promise.resolve(true); };
  speech.finalize('what are my priorities?');
  await sleep(900);
  const chatHtml = w.document.getElementById('chat-scroll').innerHTML;
  check('spoken transcript is appended to the chat', /what are my priorities\?/i.test(chatHtml));
  check('spoken turn gets an ARIA reply in the transcript', (chatHtml.match(/msg aria/g) || []).length >= 1);
  check('reply is handed to speechSynthesis', typeof spoke === 'string' && spoke.length > 0, String(spoke).slice(0, 40));

  /* Agency view: mission → live steps → final output → read aloud. */
  w.location.hash = '#/agency';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  await sleep(600);
  check('agency view renders the swarm roster', (w.document.querySelectorAll('.agent-card') || []).length >= 4);
  check('agency view exposes the shared #asst-mic', !!w.document.getElementById('asst-mic'));
  check('agency mission field is the voice input', !!w.document.querySelector('#agency-task[data-voice-input]'));
  let agencySpoke = null;
  w.AriaSpeech.speak = (t) => { agencySpoke = t; return Promise.resolve(true); };
  w.document.getElementById('agency-task').value = 'Analyze all supplier notes and draft an executive briefing';
  w.document.getElementById('agency-run').click();
  for (let i = 0; i < 40 && w.document.getElementById('agency-output-card').hidden; i++) await sleep(200);
  const steps = w.document.querySelectorAll('#agency-trace .agent-step.done');
  check('live execution shows each agent step', steps.length >= 5, `${steps.length} steps`);
  check('execution steps name the agent + action', /DirectorAgent/.test(w.document.getElementById('agency-trace').textContent) && /AnalystAgent/.test(w.document.getElementById('agency-trace').textContent));
  check('final output is rendered', /Agency mission report/i.test(w.document.getElementById('agency-output').textContent || ''));
  check('mission summary is read aloud', typeof agencySpoke === 'string' && agencySpoke.length > 0, String(agencySpoke).slice(0, 40));
  check('recent missions list is refreshed', (w.document.querySelectorAll('#agency-runs .row') || []).length >= 1);

  /* The Hub card hands a mission to the swarm. */
  w.location.hash = '#/hub';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  await sleep(500);
  check('hub shows the Agency Swarm card', !!w.document.querySelector('.agency-hub'));
  w.document.getElementById('hub-mission').value = 'Review the financial records and list the risks';
  w.document.getElementById('hub-mission-run').click();
  await sleep(400);
  check('hub card routes the mission to the swarm', w.location.hash === '#/agency');
  await sleep(1200);

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
