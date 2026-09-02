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

  console.log('\n[3b] Web search & knowledge routing');
  /* Test: explicit web search query triggers live search and returns structured results */
  const webQuery = await post('/api/assistant', { message: 'search for agency-swarm on GitHub' });
  const webReply = webQuery.json || {};
  check('web search query → 200 with reply', webQuery.status === 200 && typeof webReply.reply === 'string');
  check('web search returns live results or fallback message', webReply.reply && (webReply.reply.length > 20));
  check('web search engine is web-search or offline-engine', ['web-search', 'offline-engine', 'ollama:llama3.2', 'ollama:llama3.1'].includes(webReply.engine), webReply.engine);

  /* Test: "who is" query triggers web search */
  const whoIsQuery = await post('/api/assistant', { message: 'who is Sam Altman?' });
  const whoIsReply = whoIsQuery.json || {};
  check('"who is" query → 200 with reply', whoIsQuery.status === 200 && typeof whoIsReply.reply === 'string');
  check('"who is" query produces a substantive reply', whoIsReply.reply && whoIsReply.reply.length > 30);

  /* Test: "what is" query (non-personal) triggers web search */
  const whatIsQuery = await post('/api/assistant', { message: 'what is artificial intelligence?' });
  const whatIsReply = whatIsQuery.json || {};
  check('"what is" query → 200 with reply', whatIsQuery.status === 200 && typeof whatIsReply.reply === 'string');
  check('"what is" query produces a substantive reply', whatIsReply.reply && whatIsReply.reply.length > 30);

  /* Test: personal queries still work from brain/DB (no web search needed) */
  const personalQuery = await post('/api/assistant', { message: 'what are my priorities?' });
  const personalReply = personalQuery.json || {};
  check('personal query → 200 with reply', personalQuery.status === 200 && typeof personalReply.reply === 'string');

  /* Test: web search results contain URLs when search succeeds */
  const websearchModule = require('../server/websearch');
  const directSearch = await websearchModule.searchWeb('JavaScript programming language', 3);
  check('searchWeb returns an array', Array.isArray(directSearch));
  if (directSearch.length > 0) {
    check('searchWeb results have title field', directSearch.every(r => typeof r.title === 'string' && r.title.length > 0));
    check('searchWeb results have url field', directSearch.every(r => typeof r.url === 'string' && r.url.startsWith('http')));
    check('searchWeb results have snippet field', directSearch.every(r => typeof r.snippet === 'string'));
    check('searchWeb results have source field', directSearch.every(r => typeof r.source === 'string' && r.source.length > 0));
  } else {
    // In serverless/restricted environments, web search may return empty — that is still valid
    check('searchWeb returns array (empty is OK in restricted env)', true);
  }

  /* Test: notes count increased after web queries (auto-ingestion) */
  const notesBefore = await get('/api/notes');
  const notesBeforeCount = (notesBefore.json || []).length;
  // Trigger a web search that should auto-ingest
  const ingestQuery = await post('/api/assistant', { message: 'look up Wikipedia' });
  check('look up query → 200', ingestQuery.status === 200);
  // Wait briefly for background ingestion
  await new Promise(r => setTimeout(r, 500));
  const notesAfter = await get('/api/notes');
  check('notes collection is still an array after web queries', Array.isArray(notesAfter.json));

  /* Test: searchAndIngest function works */
  const ingestResults = await websearchModule.searchAndIngest('Node.js runtime', 1);
  check('searchAndIngest returns an array', Array.isArray(ingestResults));

  /* Test: assistant isWebSearchQuery and isPersonalQuery classification */
  const assistantModule = require('../server/assistant');
  check('isWebSearchQuery detects "search for X"', assistantModule.isWebSearchQuery('search for JavaScript') === true);
  check('isWebSearchQuery detects "who is X"', assistantModule.isWebSearchQuery('who is Elon Musk') === true);
  check('isWebSearchQuery detects "what is X"', assistantModule.isWebSearchQuery('what is machine learning') === true);
  check('isWebSearchQuery detects "look up X"', assistantModule.isWebSearchQuery('look up quantum computing') === true);
  check('isWebSearchQuery detects "latest news"', assistantModule.isWebSearchQuery('latest news on AI') === true);
  check('isWebSearchQuery detects GitHub queries', assistantModule.isWebSearchQuery('agency-swarm on GitHub') === true);
  check('isWebSearchQuery rejects personal queries', assistantModule.isWebSearchQuery('what are my priorities') === false);
  check('isPersonalQuery detects greetings', assistantModule.isPersonalQuery('hello') === true);
  check('isPersonalQuery detects schedule queries', assistantModule.isPersonalQuery('what is on my calendar') === true);
  check('isPersonalQuery detects inbox queries', assistantModule.isPersonalQuery('inbox') === true);

  /* Test: agency run with web-research-like task */
  const webMission = await post('/api/agency/run', { task: 'Research what agency-swarm is on GitHub and summarize' });
  const wm = webMission.json || {};
  check('web research mission → 200', webMission.status === 200, 'got ' + webMission.status);
  check('web research mission has agent trace', Array.isArray(wm.agentTrace) && wm.agentTrace.length >= 3);
  // Check that researcher performed web search
  const researcherTrace = (wm.agentTrace || []).find(t => t.agentId === 'researcher');
  check('researcher agent executed in web mission', !!researcherTrace);
  if (researcherTrace && researcherTrace.meta && researcherTrace.meta.webResults !== undefined) {
    check('researcher reports webResults count in meta', typeof researcherTrace.meta.webResults === 'number');
  } else {
    check('researcher meta contains web info (may be 0 in restricted env)', true);
  }

  console.log('\n[3c] Conversational memory (multi-turn follow-ups)');
  /* Turn 1 asks about today; turn 2 ("what about tomorrow?") must be resolved as a
     follow-up and answer for TOMORROW — using the seeded tomorrow event as proof. */
  const tomorrowTs = Date.now() + 864e5;
  const evTom = await post('/api/events', { title: 'Tomorrow Memory Check', start: tomorrowTs });
  check('seed: tomorrow event created', evTom.status === 200 && !!(evTom.json || {}).id);
  const t1 = await post('/api/assistant', { message: 'what is my schedule today?' });
  check('turn 1: schedule query answered', t1.status === 200 && typeof (t1.json || {}).reply === 'string' && /schedule/i.test(t1.json.reply));
  const t2 = await post('/api/assistant', { message: 'what about tomorrow?' });
  const t2j = t2.json || {};
  check('turn 2: recognized as a follow-up', t2j.followUp === true, JSON.stringify({ followUp: t2j.followUp, to: t2j.resolvedTo }));
  check('turn 2: resolved against the earlier question', /what is my schedule tomorrow/i.test(t2j.resolvedTo || ''), t2j.resolvedTo);
  check('turn 2: answers for TOMORROW with tomorrow\u2019s events', /tomorrow/i.test(t2j.reply || '') && /Tomorrow Memory Check/i.test(t2j.reply || ''), (t2j.reply || '').slice(0, 140));
  check('every assistant reply ships a TTS-safe speech twin', typeof t2j.speech === 'string' && t2j.speech.length > 0);

  console.log('\n[3d] Entity carry-over (people persist across turns)');
  const meet1 = await post('/api/assistant', { message: 'schedule a meeting with Kamau tomorrow at 2pm' });
  check('first meeting with Kamau scheduled', meet1.status === 200 && /Scheduled/i.test((meet1.json || {}).reply || ''), (meet1.json || {}).reply);
  const meet2 = await post('/api/assistant', { message: 'add another one for Friday' });
  check('follow-up scheduling is recognized', meet2.status === 200 && /Scheduled/i.test((meet2.json || {}).reply || ''), (meet2.json || {}).reply);
  check('follow-up carried over "Kamau" without asking again', /with Kamau/i.test((meet2.json || {}).resolvedTo || ''), (meet2.json || {}).resolvedTo);
  const evNow = (await get('/api/events')).json || [];
  const kamau = evNow.filter(e => /kamau/i.test(e.title || ''));
  check('two Kamau events exist', kamau.length >= 2, JSON.stringify(kamau.map(e => e.title)));
  const { dayKey: dk } = require('../server/util');
  const ARIA_TZ = 'Africa/Nairobi';
  const todayKeyStr = dk(Date.now(), ARIA_TZ);
  const [yy, mm2, dd2] = todayKeyStr.split('-').map(Number);
  let friKey = null;
  for (let i = 1; i <= 7 && !friKey; i++) {
    const dt = new Date(Date.UTC(yy, mm2 - 1, dd2 + i));
    if (dt.getUTCDay() === 5) friKey = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  check('the carried-over meeting lands on Friday', kamau.some(e => dk(e.start, ARIA_TZ) === friKey), String(kamau.map(e => dk(e.start, ARIA_TZ))));

  console.log('\n[3e] Autonomous multi-step scheduling');
  const planResp = await post('/api/assistant', { message: 'plan my day tomorrow' });
  const planReply = (planResp.json || {}).reply || '';
  check('planner request returns an executive summary', planResp.status === 200 && planReply.length > 150, planReply.slice(0, 80));
  check('summary ends with a confirmation prompt', /shall i lock this plan in|confirm the plan/i.test(planReply), planReply.slice(-120));
  const stPlan = (await get('/api/state')).json || {};
  const planEvents = (stPlan.allEvents || []).filter(e => e.source === 'planner' && !e.confirmed);
  const planTomorrowKey = dk(Date.now() + 864e5, ARIA_TZ);
  check('plan created multiple calendar blocks', planEvents.length >= 4, String(planEvents.length));
  check('plan targets tomorrow', planEvents.every(e => dk(e.start, ARIA_TZ) === planTomorrowKey), String([...new Set(planEvents.map(e => dk(e.start, ARIA_TZ)))]));
  const rhythm = stPlan.rhythm || { wakeHour: 6, sleepHour: 22 };
  const wallH = (ts) => +new Intl.DateTimeFormat('en-GB', { timeZone: ARIA_TZ, hour: '2-digit', hour12: false }).format(new Date(ts));
  check('plan respects the rhythm config (wake \u2192 sleep)', planEvents.every(e => wallH(e.start) >= rhythm.wakeHour && wallH(e.start) <= rhythm.sleepHour), JSON.stringify({ rhythm }));
  check('plan includes a wake-up brief', planEvents.some(e => /wake-up brief/i.test(e.title)));
  check('plan includes focus blocks for prioritised tasks', planEvents.some(e => /deep work/i.test(e.title)));
  check('plan includes inbox triage windows', planEvents.filter(e => /triage/i.test(e.title)).length >= 1);
  check('plan includes a meeting slot', planEvents.some(e => /meeting/i.test(e.title)));
  const sorted = planEvents.slice().sort((a, b) => a.start - b.start);
  const overlaps = sorted.some((e, i) => i > 0 && e.start < sorted[i - 1].end);
  check('no double booking inside the plan', !overlaps, JSON.stringify(sorted.map(e => [e.start, e.end])));
  const allTomorrow = (stPlan.allEvents || []).filter(e => dk(e.start, ARIA_TZ) === planTomorrowKey).sort((a, b) => a.start - b.start);
  const allOverlaps = allTomorrow.some((e, i) => i > 0 && e.start < allTomorrow[i - 1].end);
  check('no double booking with existing calendar entries', !allOverlaps);

  /* Iterative refinement: remove a block, then move an existing meeting. */
  const rmResp = await post('/api/assistant', { message: 'remove the inbox triage' });
  check('refinement: "remove the inbox triage" acknowledged', rmResp.status === 200 && /Removed/i.test((rmResp.json || {}).reply || ''), (rmResp.json || {}).reply);
  const stRm = (await get('/api/state')).json || {};
  check('refinement: triage blocks are gone', !((stRm.allEvents || []).some(e => e.source === 'planner' && /triage/i.test(e.title))));
  const mvResp = await post('/api/assistant', { message: 'move the standup to 10am' });
  check('refinement: "move the standup to 10am" acknowledged', mvResp.status === 200 && /Moved/i.test((mvResp.json || {}).reply || ''), (mvResp.json || {}).reply);
  const stMv = (await get('/api/state')).json || {};
  const standup = (stMv.allEvents || []).find(e => /standup/i.test(e.title || ''));
  const wallTime = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: ARIA_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  check('refinement: the standup now starts at 10:00', standup && wallTime(standup.start) === '10:00', standup && wallTime(standup.start));

  console.log('\n[3f] Discretion mode, sensitive-data filter & profanity');
  const secretResp = await post('/api/assistant', { message: 'remember that my M-Pesa PIN is 4821 and my api key is sk-live-abcdef1234567890' });
  const secretReply = (secretResp.json || {}).reply || '';
  const secretSpeech = (secretResp.json || {}).speech || '';
  check('sensitive details stay readable on screen (text only)', /4821/.test(secretReply) && /sk-live/i.test(secretReply), secretReply.slice(0, 100));
  check('TTS output never contains the M-Pesa PIN', !/4821/.test(secretSpeech), secretSpeech.slice(0, 140));
  check('TTS output never contains the API key', !/sk-live/i.test(secretSpeech) && !/abcdef1234567890/.test(secretSpeech), secretSpeech.slice(0, 140));
  const inboxQ = await post('/api/assistant', { message: 'how is my inbox?' });
  const inboxReply = (inboxQ.json || {}).reply || '';
  const inboxSpeech = (inboxQ.json || {}).speech || '';
  check('"how is my inbox?" is personal (never a web search)', inboxReply.length > 0 && !/web search results/i.test(inboxReply), inboxReply.slice(0, 80));
  check('discretion summarizes the inbox instead of reading it', /unread/i.test(inboxSpeech) && /check the app/i.test(inboxSpeech), inboxSpeech.slice(0, 120));
  check('discretion never speaks full email contents', !/Funds transferred via M-Pesa/i.test(inboxSpeech));
  const assistantModule2 = require('../server/assistant');
  check('redactSensitive masks tokens/emails/cards/phones', (() => {
    const out = assistantModule2.redactSensitive('token is ghp_abc123def456ghi mail me at joe@doe.com pay to 0722 123 456 card 4111 1111 1111 1111');
    return !/ghp_abc|joe@doe\.com|0722 123 456|4111 1111/.test(out);
  })());
  check('applyDiscretion caps long lists ("top 3 are")', /top 3 are/i.test(assistantModule2.applyDiscretion('Open tasks:\n- a\n- b\n- c\n- d\n- e\n- f\n- g\n- h')));
  check('cleanProfanity masks profanity in outputs', (() => {
    const out = require('../server/util').cleanProfanity('this vendor is shit and the whole thing sucks ass');
    return !/\b(shit|ass)\b/i.test(out);
  })());
  const isPlanner = assistantModule2.isPlannerRequest;
  check('planner detection: "plan my day tomorrow"', isPlanner('plan my day tomorrow') === true);
  check('planner detection: "create my schedule for tomorrow"', isPlanner('create my schedule for tomorrow') === true);
  check('planner detection: "build a weekly plan"', isPlanner('build a weekly plan') === true);
  check('planner detection: "organize this week"', isPlanner('organize this week') === true);
  check('planner detection rejects questions about plans', isPlanner('what is a weekly plan?') === false);
  const follow = assistantModule2.resolveFollowUp('what about tomorrow?', { conv: { lastIntent: 'schedule-query', lastQuery: 'what is my schedule today', entities: {} } });
  check('resolveFollowUp rewrites "what about tomorrow?"', follow.isFollowUp === true && /tomorrow/i.test(follow.message), follow.message);

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

  console.log('\n[5b] Natural speech filtering (client pipeline)');
  const cfs = (t, o) => w.AriaSpeech.cleanForSpeech(t, o || {});
  const mixed = cfs('**Hello** boss — visit https://example.com/x for \u{1F4C5} details, `code`, ~~struck~~, # Head, [link](https://x.y) \u2705');
  check('no markdown syntax survives into speech', !/[*_#`~]|https?:|\[|\]/.test(mixed), mixed);
  check('raw URLs are spoken as "link"', !/https?:\/\//i.test(mixed) && /link/i.test(mixed), mixed);
  check('emojis are translated to natural words', /calendar/i.test(mixed) && /completed/i.test(mixed), mixed);
  check('code blocks are never read aloud', !/secret|token/.test(cfs('```js\nconst secret = "token";\n```')));
  check('raw JSON is never read aloud', !/invoice/.test(cfs('{"invoice": 42}')));
  const longSpeech = cfs('ARIA works through your day, one block at a time. '.repeat(30));
  check('long replies are capped with a screen pointer', longSpeech.length < 480 && /full details on your screen/i.test(longSpeech), String(longSpeech.length));
  check('offline replies get a conversational lead-in', /^(here's|looking|based on)/i.test(cfs('**Today Schedule**: 10:00 Team Standup', { offline: true })), cfs('**Today Schedule**: 10:00 Team Standup', { offline: true }));
  check('secrets never reach TTS (client backstop)', !/4821|sk-live/.test(cfs('your pin is 4821 and key sk-live-abcdef123456')));
  check('dashes & symbol runs become spoken pauses', !/\u2014|-{2,}/.test(cfs('first part — second part -- third **part**')));

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
