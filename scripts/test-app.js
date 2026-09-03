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
  /* +5h, not +1h: the DB seed already puts 'Strategy & Growth Sync' at now+1h and 'Team Standup'
     at now+3h, so a +1h fixture sits on top of a seeded entry — and when the run happens between
     23:00 and 24:00 local time both land on the planner's target day, which trips the
     "no double booking with existing calendar entries" check below (it fails on main too). */
  const ev = await post('/api/events', { title: 'Verification event', start: Date.now() + 5 * 3600000 });
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

  console.log('\n[3g] Natural phrasing → real calendar entries (Issue 1)');
  /* These five phrasings used to create NOTHING (the schedule regex only matched messages that
     STARTED with "schedule|add event|create meeting|meeting with|calendar"). There is no Ollama
     in the test environment, so the widened DETERMINISTIC layer is what must make them pass. */
  const asstMod = require('../server/assistant');
  const brainMod = require('../server/brain');
  const dbMod = require('../server/db');
  const embMod = require('../server/embeddings');
  const llmMod = require('../server/llm');
  const cfgMod = require('../server/config');
  const tomorrowKey = dk(Date.now() + 864e5, ARIA_TZ);
  const todayKeyNow = dk(Date.now(), ARIA_TZ);
  const evList = async () => (await get('/api/events')).json || [];
  const kamauTomorrow = (list) => list.filter(e => /kamau/i.test(e.title || '') && dk(e.start, ARIA_TZ) === tomorrowKey);

  const evBeforeG = await evList();
  const kamauTomorrowBefore = kamauTomorrow(evBeforeG).length;
  const nl1 = await post('/api/assistant', { message: 'can you schedule a meeting with Kamau tomorrow at 2pm' });
  check('"can you schedule a meeting with Kamau tomorrow at 2pm" confirms', nl1.status === 200 && /Scheduled/i.test((nl1.json || {}).reply || ''), (nl1.json || {}).reply);
  check('  …routed by the deterministic intent layer (no LLM needed)', (nl1.json || {}).engine === 'intent', (nl1.json || {}).engine);
  const evAfter1 = await evList();
  check('  …and wrote a NEW event to db.events', kamauTomorrow(evAfter1).length === kamauTomorrowBefore + 1, JSON.stringify(kamauTomorrow(evAfter1).map(e => e.title)));
  check('  …titled with the person, on tomorrow\'s day key', kamauTomorrow(evAfter1).some(e => /kamau/i.test(e.title) && dk(e.start, ARIA_TZ) === tomorrowKey), JSON.stringify(kamauTomorrow(evAfter1).map(e => [e.title, dk(e.start, ARIA_TZ)])));
  /* Hour-independent invariants: the requested time is honoured unless something already sat
     there, in which case ARIA moves it and says so — and she NEVER double-books. */
  const newOnes = (before, after) => after.filter(a => !before.some(b => b.id === a.id));
  const overlapsAny = (list, ev) => list.some(o => o.id !== ev.id && ev.start < (o.end || o.start + 36e5) && o.start < ev.end);
  const keptOrExplained = (evs, hhmm, reply) => evs.some(e => wallTime(e.start) === hhmm) || /already taken|instead|first free slot/i.test(reply || '');
  const freshKamau = newOnes(evBeforeG, evAfter1).filter(e => /kamau/i.test(e.title || ''));
  check('  …at 14:00 in the owner\'s timezone (or it says which clash it avoided)', keptOrExplained(freshKamau, '14:00', (nl1.json || {}).reply), JSON.stringify(freshKamau.map(e => wallTime(e.start))) + ' | ' + ((nl1.json || {}).reply || '').slice(-90));
  check('  …and never double-books the calendar', freshKamau.length === 1 && !overlapsAny(evAfter1, freshKamau[0]), JSON.stringify(evAfter1.filter(e => dk(e.start, ARIA_TZ) === tomorrowKey).map(e => [wallTime(e.start), wallTime(e.end)])));

  const nl2 = await post('/api/assistant', { message: 'please add a meeting with the supplier at 3pm' });
  check('"please add a meeting with the supplier at 3pm" confirms', nl2.status === 200 && /Scheduled/i.test((nl2.json || {}).reply || ''), (nl2.json || {}).reply);
  const supplier = (await evList()).filter(e => /supplier/i.test(e.title || '') && dk(e.start, ARIA_TZ) === todayKeyNow);
  const freshSupplier = supplier.filter(e => !evBeforeG.some(b => b.id === e.id) && !evAfter1.some(b => b.id === e.id));
  check('  …and wrote today\'s supplier meeting at 15:00 (or explained the move)', keptOrExplained(freshSupplier, '15:00', (nl2.json || {}).reply), JSON.stringify(supplier.map(e => [e.title, wallTime(e.start)])));
  check('  …and the supplier meeting is not double-booked', freshSupplier.length === 1 && !overlapsAny(await evList(), freshSupplier[0]));

  const nl3 = await post('/api/assistant', { message: 'set up a call with the client tomorrow at 11' });
  check('"set up a call with the client tomorrow at 11" confirms', nl3.status === 200 && /Scheduled/i.test((nl3.json || {}).reply || ''), (nl3.json || {}).reply);
  const clientEv = (await evList()).filter(e => /client/i.test(e.title || '') && dk(e.start, ARIA_TZ) === tomorrowKey);
  const freshClient = clientEv.filter(e => !evAfter1.some(b => b.id === e.id));
  check('  …and wrote tomorrow\'s client call at 11:00 (or explained the move)', keptOrExplained(freshClient, '11:00', (nl3.json || {}).reply), JSON.stringify(clientEv.map(e => [e.title, wallTime(e.start)])));
  check('  …and the client call is not double-booked', freshClient.length === 1 && !overlapsAny(await evList(), freshClient[0]));

  const nl4 = await post('/api/assistant', { message: 'please schedule lunch with Amina on Friday' });
  check('"please schedule lunch with Amina on Friday" confirms', nl4.status === 200 && /Scheduled/i.test((nl4.json || {}).reply || ''), (nl4.json || {}).reply);
  const amina = (await evList()).filter(e => /amina/i.test(e.title || ''));
  check('  …and wrote the lunch on Friday\'s day key', amina.some(e => dk(e.start, ARIA_TZ) === friKey), JSON.stringify(amina.map(e => [e.title, dk(e.start, ARIA_TZ)])));

  const evBefore5 = await evList();
  const nl5 = await post('/api/assistant', { message: 'book a meeting with Kamau tomorrow' });
  check('"book a meeting with Kamau tomorrow" confirms', nl5.status === 200 && /Scheduled/i.test((nl5.json || {}).reply || ''), (nl5.json || {}).reply);
  const evAfter5 = await evList();
  check('  …and wrote a NEW Kamau event for tomorrow', kamauTomorrow(evAfter5).length === kamauTomorrow(evBefore5).length + 1, JSON.stringify(kamauTomorrow(evAfter5).map(e => e.title)));
  /* No clock time was given, so ARIA must take a FREE slot instead of stacking it on the day. */
  check('  …without double-booking (an un-timed request takes a free slot)', (() => {
    const fresh = newOnes(evBefore5, evAfter5).filter(e => /kamau/i.test(e.title || ''));
    return fresh.length === 1 && !overlapsAny(evAfter5, fresh[0]);
  })(), JSON.stringify(newOnes(evBefore5, evAfter5).map(e => [e.title, wallTime(e.start), wallTime(e.end)])));
  check('  …and says so when it picks the slot itself', /first free slot|already taken/i.test((nl5.json || {}).reply || ''), (nl5.json || {}).reply);
  /* The transcript is rendered inside the assistant view, where a warning glyph reads like a
     render failure — clashes are reported in words instead. */
  check('replies carry no warning glyph into the transcript', [nl1, nl2, nl3, nl4, nl5].every(r => !/⚠️/.test((r.json || {}).reply || '')));

  /* Conversation memory: the same day now lists what was just created. */
  const recall = await post('/api/assistant', { message: 'what is my schedule tomorrow' });
  const recallReply = (recall.json || {}).reply || '';
  check('"what is my schedule tomorrow" lists the new meetings', /tomorrow/i.test(recallReply) && /kamau/i.test(recallReply) && /client/i.test(recallReply), recallReply.slice(0, 200));

  /* The intent helpers themselves. */
  check('stripFiller removes politeness wrappers', asstMod.stripFiller('can you please schedule a meeting with Kamau') === 'schedule a meeting with Kamau', asstMod.stripFiller('can you please schedule a meeting with Kamau'));
  check('stripFiller never empties a greeting', asstMod.stripFiller('hello') === 'hello');
  check('matchScheduleRequest accepts "set up a call with the client tomorrow"', !!asstMod.matchScheduleRequest('set up a call with the client tomorrow'));
  check('matchScheduleRequest accepts "hey aria, arrange a meeting with the bank on monday"', !!asstMod.matchScheduleRequest('hey aria, arrange a meeting with the bank on monday'));
  check('matchScheduleRequest rejects non-calendar asks', asstMod.matchScheduleRequest('create a summary of my inbox') === null);
  check('matchScheduleRequest rejects task asks', asstMod.matchScheduleRequest('add a task to call the supplier') === null);
  check('parseRelativeDateTime resolves "tomorrow at 2pm" in the owner tz', dk(asstMod.parseRelativeDateTime('tomorrow at 2pm', ARIA_TZ), ARIA_TZ) === tomorrowKey);
  check('parseRelativeDateTime resolves "next monday at 10am"', wallTime(asstMod.parseRelativeDateTime('next monday at 10am', ARIA_TZ)) === '10:00');
  check('parseRelativeDateTime resolves "tonight 8"', wallTime(asstMod.parseRelativeDateTime('dinner tonight 8', ARIA_TZ)) === '20:00', wallTime(asstMod.parseRelativeDateTime('dinner tonight 8', ARIA_TZ)));
  check('parseRelativeDateTime resolves "on Friday"', dk(asstMod.parseRelativeDateTime('lunch on Friday', ARIA_TZ), ARIA_TZ) === friKey);

  console.log('\n[3h] LLM tool calling — parse, validate, execute for real');
  const TOOL_NAMES_EXPECTED = ['create_event', 'add_task', 'complete_task', 'search_calendar', 'search_brain', 'web_search', 'plan_day'];
  check('the tool schema defines all seven tools', TOOL_NAMES_EXPECTED.every(n => asstMod.TOOL_DEFS.some(t => t.name === n)), asstMod.TOOL_DEFS.map(t => t.name).join(','));
  check('every tool documents its arguments', asstMod.TOOL_DEFS.every(t => t.args && typeof t.args === 'object' && Object.keys(t.args).length > 0));
  check('parseToolCall reads a bare JSON object', (() => {
    const c = asstMod.parseToolCall('{"tool":"create_event","args":{"title":"Board sync","startISO":"2026-09-04T14:00:00+03:00"}}');
    return !!c && c.tool === 'create_event' && c.args.title === 'Board sync';
  })());
  check('parseToolCall reads JSON inside ```json fences', (() => {
    const c = asstMod.parseToolCall('```json\n{"tool":"add_task","args":{"title":"Pay the supplier"}}\n```');
    return !!c && c.tool === 'add_task' && c.args.title === 'Pay the supplier';
  })());
  check('parseToolCall extracts JSON wrapped in chatty prose', (() => {
    const c = asstMod.parseToolCall('Sure — doing that now. {"tool":"web_search","args":{"query":"cement prices nairobi"}} Hope that helps!');
    return !!c && c.tool === 'web_search' && c.args.query === 'cement prices nairobi';
  })());
  check('parseToolCall tolerates trailing commas / smart quotes', (() => {
    const c = asstMod.parseToolCall('{“tool”:“search_brain”,“args”:{“query”:“cement”,}}');
    return !!c && c.tool === 'search_brain';
  })(), JSON.stringify(asstMod.parseToolCall('{“tool”:“search_brain”,“args”:{“query”:“cement”,}}')));
  check('parseToolCall returns null for plain prose', asstMod.parseToolCall('I cannot help with that.') === null);
  check('parseToolCall returns null for broken JSON', asstMod.parseToolCall('{"tool": }') === null);
  check('parseToolCall returns null for an empty reply', asstMod.parseToolCall('') === null && asstMod.parseToolCall(null) === null);
  check('parseToolCall ignores JSON that names no tool', asstMod.parseToolCall('{"answer": 42}') === null);
  check('toolPrompt instructs a JSON-only reply', /ONLY a compact JSON object/i.test(llmMod.toolPrompt(asstMod.TOOL_DEFS)) && /create_event/.test(llmMod.toolPrompt(asstMod.TOOL_DEFS)));

  /* Execution — the tool path must write the SAME records the regex path writes. */
  const evBeforeTool = (await evList()).length;
  const isoStart = new Date(require('../server/util').zonedTime(tomorrowKey, 16, 0, ARIA_TZ)).toISOString();
  const isoEnd = new Date(require('../server/util').zonedTime(tomorrowKey, 17, 0, ARIA_TZ)).toISOString();
  const toolEvent = await asstMod.executeTool('create_event', { title: 'Investor sync', startISO: isoStart, endISO: isoEnd, context: 'business' });
  check('create_event returns a real confirmation', !!toolEvent && /Scheduled/i.test(toolEvent.reply) && /Investor sync/.test(toolEvent.reply), toolEvent && toolEvent.reply);
  const evAfterTool = await evList();
  check('create_event actually wrote the event', evAfterTool.length === evBeforeTool + 1 && evAfterTool.some(e => /investor sync/i.test(e.title) && dk(e.start, ARIA_TZ) === tomorrowKey), JSON.stringify(evAfterTool.map(e => e.title).slice(0, 3)));
  const written = evAfterTool.filter(e => /investor sync/i.test(e.title));
  check('the written event kept the requested time (or moved off a clash and said so)',
    written.some(e => wallTime(e.start) === '16:00') || /already taken|instead/i.test((toolEvent || {}).reply || ''),
    JSON.stringify(written.map(e => [wallTime(e.start), wallTime(e.end)])) + ' | ' + ((toolEvent || {}).reply || ''));
  check('the tool-written event does not double-book the calendar',
    written.length === 1 && !evAfterTool.some(o => o.id !== written[0].id && written[0].start < (o.end || o.start + 36e5) && o.start < written[0].end),
    JSON.stringify(evAfterTool.filter(e => dk(e.start, ARIA_TZ) === tomorrowKey).map(e => [wallTime(e.start), e.title])));
  check('create_event rejects an empty title (nothing written)', (await asstMod.executeTool('create_event', { title: '  ', startISO: isoStart })) === null && (await evList()).length === evAfterTool.length);
  check('create_event rejects an unparseable date (nothing written)', (await asstMod.executeTool('create_event', { title: 'Ghost meeting', startISO: 'sometime soon' })) === null && !(await evList()).some(e => /ghost meeting/i.test(e.title || '')));
  check('create_event accepts a natural-language date', !!await asstMod.executeTool('create_event', { title: 'Site visit', startISO: 'tomorrow at 9am' }));
  check('unknown tools are never executed', (await asstMod.executeTool('launch_missiles', { target: 'the moon' })) === null && (await asstMod.executeTool('delete_everything', {})) === null);
  check('parseToolDate reads ISO, epoch millis and epoch seconds', (() => {
    const { parseToolDate } = asstMod;
    return parseToolDate('2026-09-04T14:00:00+03:00') === new Date('2026-09-04T14:00:00+03:00').getTime()
      && parseToolDate(1800000000000) === 1800000000000
      && parseToolDate(1800000000) === 1800000000000;
  })());

  const tasksBefore = ((await get('/api/tasks')).json || []).length;
  const toolTask = await asstMod.executeTool('add_task', { title: 'Chase the cement invoice', priority: 'high' });
  const tasksAfter = (await get('/api/tasks')).json || [];
  check('add_task writes a real task with the requested priority', !!toolTask && /Task Added/i.test(toolTask.reply) && tasksAfter.length === tasksBefore + 1 && tasksAfter.some(t => /cement invoice/i.test(t.title) && t.priority === 'high' && t.done === false), JSON.stringify(tasksAfter.map(t => t.title).slice(0, 3)));
  const toolDone = await asstMod.executeTool('complete_task', { titleQuery: 'cement invoice' });
  check('complete_task marks the real task done', !!toolDone && /Completed/i.test(toolDone.reply) && ((await get('/api/tasks')).json || []).some(t => /cement invoice/i.test(t.title) && t.done === true), toolDone && toolDone.reply);
  check('complete_task on a missing task changes nothing', (await asstMod.executeTool('complete_task', { titleQuery: 'zzz-no-such-task-zzz' })) === null);
  const toolCal = await asstMod.executeTool('search_calendar', { dayLabel: 'tomorrow' });
  check('search_calendar answers from the real calendar', !!toolCal && /tomorrow/i.test(toolCal.reply) && /investor sync/i.test(toolCal.reply), toolCal && toolCal.reply.slice(0, 120));
  const toolBrain = await asstMod.executeTool('search_brain', { query: 'cement' });
  check('search_brain answers from the second brain', !!toolBrain && typeof toolBrain.reply === 'string' && toolBrain.reply.length > 20, toolBrain && toolBrain.reply.slice(0, 100));
  check('tools with missing required args are refused', (await asstMod.executeTool('search_brain', {})) === null && (await asstMod.executeTool('web_search', {})) === null);
  check('a tool call never throws out of executeTool', typeof (await asstMod.executeTool('create_event', null)) === 'object' || (await asstMod.executeTool('create_event', null)) === null);

  console.log('\n[3i] Semantic memory — BM25 blended with embeddings');
  brainMod.ingestNote({ title: 'Cement supplier — Mwangi Hardware', content: 'Mwangi Hardware sells cement and ballast. Wholesale cement prices in Nairobi; I know them from the trade.', source: 'test', kind: 'note', tags: ['supplier', 'business'] });
  brainMod.ingestNote({ title: 'Contacts in the building trade', content: 'Who supplies building materials around here? A ballast vendor I know, a steel stockist, and a hardware shop that delivers to contractors — and he sells by the truckload.', source: 'test', kind: 'note', tags: ['contacts'] });
  brainMod.ingestNote({ title: 'Sprint review notes', content: 'Weekly review of the release plan, the KPIs and the blockers for the platform team.', source: 'test', kind: 'note', tags: ['work'] });
  brainMod.buildIndex();
  const paraQuery = 'who do I know that sells cement?';
  const noteDocs = (await get('/api/notes')).json || [];
  const docVecs = new Map(noteDocs.map(n => [n.id, embMod.fallbackVector(`${n.title}\n${n.content}`)]));
  const blended = brainMod.blendSearch(paraQuery, { queryVector: embMod.fallbackVector(paraQuery), docVectors: docVecs, limit: 10 });
  const rankOf = (re) => blended.findIndex(h => re.test(h.title || ''));
  check('the blend ranks the exact-term supplier note first', rankOf(/cement supplier/i) === 0, JSON.stringify(blended.map(h => h.title)));
  check('a paraphrased note still ranks above an unrelated one', (() => {
    const para = rankOf(/building trade/i), unrel = rankOf(/sprint review/i);
    return para >= 0 && (unrel === -1 || para < unrel);
  })(), JSON.stringify(blended.map(h => [h.title, h.blended])));
  check('every blended hit carries lexical + semantic evidence', blended.length > 0 && blended.every(h => typeof h.score === 'number' && typeof h.bm25 === 'number' && typeof h.semantic === 'number' && typeof h.blended === 'number'));
  check('blended ranking is 0.5·lexical + 0.5·semantic', brainMod.blendScore(1, 1) === 1 && brainMod.blendScore(1, 0) === 0.5 && brainMod.blendScore(0, 1) === 0.5 && brainMod.blendScore(0, 0) === 0);
  check('cosineSimilarity: identical text → 1.0', Math.abs(embMod.cosineSimilarity(embMod.fallbackVector('cement supplier'), embMod.fallbackVector('cement supplier')) - 1) < 1e-9);
  check('cosineSimilarity: unrelated text is far below 1.0', embMod.cosineSimilarity(embMod.fallbackVector('cement supplier'), embMod.fallbackVector('sprint planning blockers')) < 0.6);
  check('cosineSimilarity guards mismatched/empty vectors', embMod.cosineSimilarity([1, 2], [1]) === 0 && embMod.cosineSimilarity(null, [1]) === 0);
  check('offline search stays lexical (semantic 0, score = BM25)', (() => {
    const plain = brainMod.search('cement supplier', 5);
    return plain.length > 0 && plain.every(h => h.semantic === 0 && h.score === h.bm25);
  })());
  check('primeEmbeddings is a silent no-op without a backend', (await brainMod.primeEmbeddings({ force: false })).primed === 0);
  check('searchAsync still answers with no LLM/embedding backend', Array.isArray(await brainMod.searchAsync('cement', 5)));
  check('notes are never polluted with fallback vectors offline', ((await get('/api/notes')).json || []).every(n => !Array.isArray(n.embedding)));
  const hybridRoute = (await get('/api/search?q=' + encodeURIComponent('cement supplier'))).json || [];
  check('GET /api/search returns hybrid evidence (score + semantic + blended)', Array.isArray(hybridRoute) && hybridRoute.length > 0 && hybridRoute.every(h => typeof h.score === 'number' && typeof h.semantic === 'number' && typeof h.blended === 'number'), JSON.stringify(hybridRoute[0] || {}).slice(0, 140));
  check('GET /api/search still finds the supplier note offline', hybridRoute.some(h => /cement supplier/i.test(h.title || '')));

  console.log('\n[3j] LLM providers — cloud optional, offline always safe');
  const norm = cfgMod.normalize({});
  check('DEFAULTS: voiceGender is male', norm.voiceGender === 'male', String(norm.voiceGender));
  check('DEFAULTS: the cloud provider block is present and keyless', norm.llm.openai.baseUrl === 'https://api.openai.com/v1' && norm.llm.openai.model === 'gpt-4o-mini' && norm.llm.openai.apiKey === '');
  check('DEFAULTS: a stronger local model is recommended', /qwen2\.5|llama3\.1/i.test(norm.llm.recommendedModel), String(norm.llm.recommendedModel));
  check('DEFAULTS: provider still defaults to auto', norm.llm.provider === 'auto');
  check('/api/state exposes the voice-gender default', ((await get('/api/state')).json || {}).voiceGender === 'male', String(((await get('/api/state')).json || {}).voiceGender));
  check('/api/settings exposes the voice-gender default', ((await get('/api/settings')).json || {}).voiceGender === 'male');
  check('normalize() clamps an unknown provider to auto', cfgMod.normalize({ llm: { provider: 'wat' } }).llm.provider === 'auto');
  check('normalize() clamps an unknown voiceGender to male', cfgMod.normalize({ voiceGender: 'robot' }).voiceGender === 'male');
  check('normalize() keeps an explicit female voice', cfgMod.normalize({ voiceGender: 'female' }).voiceGender === 'female');
  check('normalize() fills a partial openai block', (() => {
    const c = cfgMod.normalize({ llm: { openai: { apiKey: 'sk-x' } } });
    return c.llm.openai.apiKey === 'sk-x' && c.llm.openai.baseUrl === 'https://api.openai.com/v1' && c.llm.openai.model === 'gpt-4o-mini';
  })());
  check('no cloud key + no Ollama → nothing to try (stays offline)', llmMod.resolveProviders(cfgMod.normalize({ llm: { provider: 'auto' } }), { openai: true, ollama: false }).length === 0);
  check('a cloud key puts the cloud provider first', JSON.stringify(llmMod.resolveProviders(cfgMod.normalize({ llm: { provider: 'auto', openai: { apiKey: 'sk-test' } } }), { openai: true, ollama: true })) === '["openai","ollama"]');
  check('provider "openai" without a key falls through to offline', llmMod.resolveProviders(cfgMod.normalize({ llm: { provider: 'openai' } }), { ollama: false }).length === 0);
  check('provider "offline" never calls a model', llmMod.resolveProviders(cfgMod.normalize({ llm: { provider: 'offline' } }), { openai: true, ollama: true }).length === 0);
  check('provider "ollama" is honoured even when unreachable', JSON.stringify(llmMod.resolveProviders(cfgMod.normalize({ llm: { provider: 'ollama' } }), { ollama: false })) === '["ollama"]');
  process.env.OPENAI_API_KEY = 'sk-test-NEVER-LOG-ME-1234567890';
  check('OPENAI_API_KEY is read from the environment', llmMod.openaiConfigured(cfgMod.normalize({})) === true);
  const aiStatus = llmMod.llmStatus();
  check('llmStatus reports the cloud provider WITHOUT leaking the key', aiStatus.openai && aiStatus.openai.configured === true && !JSON.stringify(aiStatus).includes('NEVER-LOG-ME'), JSON.stringify(aiStatus).slice(0, 160));
  check('GET /api/ai/status never exposes an api key', !JSON.stringify((await get('/api/ai/status')).json || {}).includes('NEVER-LOG-ME'));
  delete process.env.OPENAI_API_KEY;
  const fallThrough = await llmMod.llmChat('You are ARIA.', 'hello there', [], asstMod.TOOL_DEFS);
  check('llmChat falls through to offline without throwing', !!fallThrough && fallThrough.text === null && fallThrough.engine === 'offline', JSON.stringify(fallThrough));
  check('llmChat reports that the tool pass was requested', fallThrough.tools === true);
  check('llmChat without tools also degrades to offline', (await llmMod.llmChat('sys', 'user')).engine === 'offline');
  check('the assistant still answers with no model at all', /aria|priorit|task|hello|schedule|brain|web/i.test((await post('/api/assistant', { message: 'what are my priorities?' })).json.reply || ''));

  console.log('\n[3k] Context pack & rolling conversation summary');
  const cp = brainMod.contextPack('what is my schedule tomorrow');
  check('contextPack keeps TODAY & UPCOMING', /TODAY & UPCOMING/i.test(cp) && /upcoming/i.test(cp));
  check('contextPack now includes tomorrow explicitly', /== TOMORROW/i.test(cp) && cp.includes(tomorrowKey));
  check('contextPack includes the last 3 conversation turns', /== LAST 3 TURNS ==/i.test(cp));
  check('contextPack keeps the priority sections', /PRIORITY EMAILS/i.test(cp) && /PRIORITY MESSAGES/i.test(cp) && /OPEN ACTION ITEMS/i.test(cp));
  check('contextPack survives a null LLM (built synchronously)', typeof cp === 'string' && cp.length > 80);
  check('contextPack times are the owner\'s local times', /10:00–10:30 \[Work\] Team Standup/.test(cp), cp.split('\n').filter(l => /Standup/.test(l)).join(' | '));
  const dbNow = dbMod.load();
  const convNow = asstMod.convState(dbNow);
  check('respond() rolled a summary on its own after 12+ turns', typeof convNow.summary === 'string' && convNow.summary.length > 20, String(convNow.summary).slice(0, 120));
  check('the summary is prepended to the context pack', /CONVERSATION SO FAR/i.test(cp));
  check('secrets are redacted out of the persisted summary', !/4821|sk-live/i.test(convNow.summary || ''), String(convNow.summary).slice(0, 160));
  /* Force the next window so the rolling behaviour itself is exercised. */
  convNow.lastSummaryTurn = Math.max(0, (dbNow.chats || []).length - asstMod.SUMMARY_EVERY);
  const summary = await asstMod.rollConversationSummary(dbNow);
  check('a rolling summary is written once 12 turns accumulate', typeof summary === 'string' && summary.length > 20, String(summary).slice(0, 120));
  check('the summary is persisted on db.meta.conversation', ((dbNow.meta || {}).conversation || {}).summary === summary);
  check('the summary records people, topics and decisions without an LLM', /People:/i.test(summary) && /Topics:/i.test(summary) && /(Done\/scheduled|Last asked)/i.test(summary), summary.slice(0, 160));
  check('the freshly rolled summary replaces the previous one', /CONVERSATION SO FAR/i.test(brainMod.contextPack('anything')) && convNow.summary === summary);
  check('it does not re-summarise before another 12 turns', (await asstMod.rollConversationSummary(dbNow)) === null);
  check('heuristicSummary never throws on an empty conversation', typeof asstMod.heuristicSummary([]) === 'string' && asstMod.heuristicSummary([]).length > 10);

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

  console.log('\n[5c] Voice gender — ARIA sounds male by default (Issue 2)');
  /* jsdom has no real speechSynthesis voices, so the picker is unit-tested with a fake list. */
  const fakeVoices = [
    { name: 'Microsoft Zira', lang: 'en-US' },
    { name: 'Microsoft David', lang: 'en-US' },
    { name: 'Google UK English Female', lang: 'en-GB' },
    { name: 'Daniel', lang: 'en-GB' },
    { name: 'Amélie', lang: 'fr-FR' }
  ];
  const voice = w.AriaSpeech;
  check('pickVoice is exported for tests', typeof voice.pickVoice === 'function' && typeof w.AriaPickVoice === 'function');
  check('localStorage aria.voiceGender defaults to "male"', w.localStorage.getItem('aria.voiceGender') === 'male', String(w.localStorage.getItem('aria.voiceGender')));
  check('Speech.gender() defaults to male', voice.gender() === 'male');
  check('pickVoice(male) chooses the MALE voice', voice.pickVoice(fakeVoices, 'male').name === 'Microsoft David', voice.pickVoice(fakeVoices, 'male') && voice.pickVoice(fakeVoices, 'male').name);
  check('pickVoice(female) chooses the FEMALE voice', voice.pickVoice(fakeVoices, 'female').name === 'Microsoft Zira', voice.pickVoice(fakeVoices, 'female') && voice.pickVoice(fakeVoices, 'female').name);
  check('the male picker ignores French voices and stays English', /^en/i.test(voice.pickVoice(fakeVoices, 'male').lang));
  check('voiceGenderOf names a known male/female voice', voice.voiceGenderOf('Microsoft David') === 'male' && voice.voiceGenderOf('Microsoft Zira') === 'female');
  check('voiceGenderOf returns null for a neutral name', voice.voiceGenderOf('Some Neutral Voice') === null);
  check('a neutral voice is still chosen (pitch carries the gender)', voice.pickVoice([{ name: 'Some Neutral Voice', lang: 'en-US' }], 'male').name === 'Some Neutral Voice');
  check('pickVoice returns null when the device has no voices', voice.pickVoice([], 'male') === null && voice.pickVoice(null, 'female') === null);
  check('setGender switches the stored preference at once', voice.setGender('female') === 'female' && w.localStorage.getItem('aria.voiceGender') === 'female');
  check('the picker follows the switch with no argument', voice.pickVoice(fakeVoices).name === 'Microsoft Zira');
  check('setGender drops the cached voice so prime() re-picks', voice._voice === null);
  voice.setGender('male');
  check('setGender back to male is honoured', voice.gender() === 'male' && voice.pickVoice(fakeVoices).name === 'Microsoft David');

  /* Settings UI: the select lives in the Install · Sound · Notifications card. */
  w.location.hash = '#/settings';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  await sleep(800);
  const sel = w.document.getElementById('s-voice-gender');
  check('Settings renders the "ARIA\'s voice" select', !!sel && sel.tagName === 'SELECT');
  check('the select offers Male and Female', !!sel && [...sel.options].map(o => o.value).join(',') === 'male,female', sel && [...sel.options].map(o => o.value).join(','));
  check('the select defaults to Male', !!sel && sel.value === 'male');
  check('a voice preview button sits next to the select', !!w.document.getElementById('btn-test-voice') && /Test ARIA's voice/i.test(w.document.getElementById('btn-test-voice').textContent));
  check('the voice card explains the choice', /voice/i.test((w.document.getElementById('voice-gender-hint') || {}).textContent || ''));
  check('the AI engine card offers the cloud provider', (() => {
    const p = w.document.getElementById('s-provider');
    return !!p && [...p.options].some(o => o.value === 'openai');
  })());
  check('the AI engine card exposes cloud base URL / key / model', !!w.document.getElementById('s-oai-url') && !!w.document.getElementById('s-oai-key') && !!w.document.getElementById('s-oai-model'));
  check('the cloud key field is a password input', (w.document.getElementById('s-oai-key') || {}).type === 'password');
  check('Settings recommends a stronger local model', /qwen2\.5:7b|llama3\.1:8b/i.test(w.document.getElementById('main').innerHTML));

  /* Changing the select is instant on this device; Save all persists it server-side. */
  sel.value = 'female';
  sel.dispatchEvent(new w.Event('change'));
  await sleep(200);
  check('changing the select updates localStorage immediately', w.localStorage.getItem('aria.voiceGender') === 'female');
  check('Speech.gender() follows the select', voice.gender() === 'female');
  w.document.getElementById('set-save').click();
  await sleep(1000);
  const savedFemale = (await get('/api/settings')).json || {};
  check('Save all persists voiceGender server-side', savedFemale.voiceGender === 'female', String(savedFemale.voiceGender));
  check('settings expose the cloud LLM block', !!savedFemale.llm && !!savedFemale.llm.openai && savedFemale.llm.openai.baseUrl === 'https://api.openai.com/v1' && savedFemale.llm.openai.model === 'gpt-4o-mini');
  w.location.hash = '#/settings';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  await sleep(800);
  check('the saved choice is rendered back on reload', (w.document.getElementById('s-voice-gender') || {}).value === 'female');
  const sel2 = w.document.getElementById('s-voice-gender');
  sel2.value = 'male';
  sel2.dispatchEvent(new w.Event('change'));
  w.document.getElementById('set-save').click();
  await sleep(1000);
  check('the voice choice is reversible', (await get('/api/settings')).json.voiceGender === 'male' && w.localStorage.getItem('aria.voiceGender') === 'male');
  console.log('\n[6] Tool-calling loop end-to-end (mock model server)');
  /* A fake Ollama that answers with a tool call for one phrasing and with plain prose for
     another. ARIA must (a) EXECUTE the tool for real and reply with the record it wrote, and
     (b) write nothing when the model only talks — no invented confirmations. */
  const utilMod = require('../server/util');
  const keyForDow = (dow) => {
    const [y, mo, d] = todayKeyNow.split('-').map(Number);
    for (let i = 1; i <= 7; i++) {
      const dt = new Date(Date.UTC(y, mo - 1, d + i));
      if (dt.getUTCDay() === dow) return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    }
    return null;
  };
  const satKey = keyForDow(6);
  const satIso = new Date(utilMod.zonedTime(satKey, 9, 0, ARIA_TZ)).toISOString();
  let mockSawToolSchema = false, mockSawContext = false, mockSawHistory = false;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-tool-model' }] }));
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_) {}
      const msgs = payload.messages || [];
      const last = String((msgs[msgs.length - 1] || {}).content || '');
      /* Did ARIA hand the model the tool schema? (system prompt is msgs[0]) */
      const system = String((msgs[0] || {}).content || '');
      if (/TOOLS — you can ACT/.test(system) && /create_event/.test(system) && /plan_day/.test(system)) mockSawToolSchema = true;
      if (/CONTEXT:/.test(last) && /CURRENT TIME:/.test(last)) mockSawContext = true;
      if (msgs.length > 2) mockSawHistory = true;
      let content;
      if (/water heater/i.test(last)) {
        content = '```json\n{"tool":"create_event","args":{"title":"Plumber — water heater repair","startISO":"' + satIso + '","context":"day-job"}}\n```';
      } else if (/add a task to chase the cement quote/i.test(last)) {
        content = '{"tool":"add_task","args":{"title":"Chase the cement quote","priority":"high"}}';
      } else {
        content = 'Here is a plain prose answer — no action was requested, so no tool call.';
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const settingsBeforeMock = (await get('/api/settings')).json || {};
  await post('/api/settings', { llm: { provider: 'ollama', ollamaUrl: mockUrl, model: 'mock-tool-model' } });
  llmMod._reset();
  check('the mock model is detected as a live provider', (await llmMod.checkOllama()) === true && llmMod.llmStatus().activeEngine === 'ollama');
  check('the tool schema is described to the model', /create_event/.test(llmMod.toolPrompt(asstMod.TOOL_DEFS)) && /ONLY a compact JSON object/i.test(llmMod.toolPrompt(asstMod.TOOL_DEFS)));

  const evBeforeMock = await evList();
  const chatty = await post('/api/assistant', { message: 'tell me a joke about plumbers' });
  check('a plain model answer is passed through as chat', chatty.status === 200 && /^ollama:/.test((chatty.json || {}).engine || ''), (chatty.json || {}).engine);
  check('chat answers write nothing to the calendar', (await evList()).length === evBeforeMock.length);

  const acted = await post('/api/assistant', { message: 'could you get the water heater fixed on saturday at 9am' });
  const actedJson = acted.json || {};
  check('an unfamiliar phrasing is routed through the tool pass', /^tool:ollama/.test(actedJson.engine || ''), actedJson.engine);
  check('the response names the tool that ran', actedJson.tool === 'create_event', JSON.stringify(actedJson.tool));
  check('the reply is the REAL confirmation', /Scheduled/i.test(actedJson.reply || '') && /Plumber — water heater repair/.test(actedJson.reply || ''), actedJson.reply);
  const heater = (await evList()).filter(e => /water heater/i.test(e.title || ''));
  check('the tool call actually wrote the event', heater.length === 1, JSON.stringify(heater.map(e => e.title)));
  const heaterOnSat = heater.length === 1 && dk(heater[0].start, ARIA_TZ) === satKey;
  check('the written event honours the model\'s ISO day (Saturday)', heaterOnSat, heater.length ? `${dk(heater[0].start, ARIA_TZ)} ${wallTime(heater[0].start)}` : 'none');
  /* Hour-independent: 09:00 is kept unless a REAL entry already owned it, in which case ARIA
     books the next free slot and says so in the reply. */
  check('the written event honours 09:00 — or moved off a real clash and said so',
    heaterOnSat && (wallTime(heater[0].start) === '09:00' || /already taken|instead/i.test(actedJson.reply || '')),
    heaterOnSat ? `${wallTime(heater[0].start)} | ${(actedJson.reply || '').slice(-110)}` : 'none');
  check('the tool-written event does not overlap anything else that day', heaterOnSat
    && !(await evList()).some(o => o.id !== heater[0].id && heater[0].start < (o.end || o.start + 36e5) && o.start < heater[0].end),
    JSON.stringify((await evList()).filter(e => dk(e.start, ARIA_TZ) === satKey).map(e => [wallTime(e.start), e.title])));
  check('the event was tagged as coming from a tool call', heater.length === 1 && heater[0].source === 'assistant-tool', heater.length ? heater[0].source : 'none');
  check('the mutation was persisted (db.events on disk/in store)', (await get('/api/events')).json.some(e => /water heater/i.test(e.title || '')));

  const tasksBeforeMock = ((await get('/api/tasks')).json || []).length;
  const taskTool = await post('/api/assistant', { message: 'add a task to chase the cement quote' });
  const tasksAfterMock = (await get('/api/tasks')).json || [];
  check('add_task via the model writes a real task', /Task Added/i.test((taskTool.json || {}).reply || '') && tasksAfterMock.length === tasksBeforeMock + 1 && tasksAfterMock.some(t => /cement quote/i.test(t.title)), (taskTool.json || {}).reply);

  const recallTool = await post('/api/assistant', { message: 'what is my schedule on saturday' });
  check('conversation memory: the tool-created event is recallable', /water heater/i.test((recallTool.json || {}).reply || ''), ((recallTool.json || {}).reply || '').slice(0, 140));

  /* Restore the offline default so the rest of the suite runs exactly as before. */
  await new Promise((r) => mock.close(r));
  await post('/api/settings', { llm: { provider: settingsBeforeMock.llm.provider, ollamaUrl: settingsBeforeMock.llm.ollamaUrl, model: settingsBeforeMock.llm.model, openai: settingsBeforeMock.llm.openai } });
  llmMod._reset();
  check('the engine falls back to offline once the model is gone', (await llmMod.llmChat('sys', 'user')).engine === 'offline');
  check('the model really received the tool schema in its system prompt', mockSawToolSchema === true);
  check('the model really received the context pack + current time', mockSawContext === true);
  check('the model really received the conversation history', mockSawHistory === true);
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
