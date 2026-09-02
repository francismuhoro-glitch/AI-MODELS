'use strict';
/* AGENCY SWARM — a lightweight, zero-dependency multi-agent orchestrator.

   ARIA (DirectorAgent) is the Executive Chief of Staff: it parses a complex multi-step
   instruction, delegates the sub-tasks to specialised background agents, and signs off the
   synthesis. Agents never call each other — they read/write one shared mission context, so
   the same roster runs either sequentially or in parallel waves.

   Public surface:
     listAgents()            → the roster (serialisable cards)
     plan(task, agents)      → the delegation plan, without executing it
     run({task, agents, mode}) → { finalOutput, agentTrace: [{agent, action, result}], … }
     history(limit)          → recent missions (persisted with the rest of the state) */

const dbm = require('./db');
const cfgm = require('./config');
const brain = require('./brain');
const registry = require('./agents');
const { snippet } = require('./util');

const MAX_RUNS = 40;
const MODES = ['sequential', 'parallel'];

const listAgents = () => registry.list();

function normalizeMode(mode) {
  const m = String(mode || 'sequential').toLowerCase();
  return MODES.includes(m) ? m : 'sequential';
}

function makePlan(task, agents) {
  return registry.director.plan(String(task || '').trim(), registry.roster(), agents);
}

/* Plan only — used by the UI to render the queued steps before execution starts. */
function plan(task, agents) {
  const t = String(task || '').trim();
  if (!t) throw Object.assign(new Error('task required'), { status: 400 });
  const p = makePlan(t, agents);
  return {
    ok: true,
    task: t,
    subtasks: p.subtasks,
    agents: p.agents,
    assignments: p.assignments,
    director: registry.director.card()
  };
}

async function runAgent(agent, ctx, method = 'run') {
  const startedAt = Date.now();
  let step;
  try {
    step = await agent[method](ctx);
  } catch (e) {
    console.error('[agency]', agent.id, (e && e.stack) || e);
    step = agent.failStep(method, e);
  }
  step.startedAt = startedAt;
  step.ms = Date.now() - startedAt;
  ctx.trace.push(step);
  return step;
}

async function run(opts = {}) {
  const task = String(opts.task || '').trim();
  if (!task) throw Object.assign(new Error('task required'), { status: 400 });

  const mode = normalizeMode(opts.mode);
  const roster = registry.roster();
  const p = makePlan(task, opts.agents);

  const ctx = {
    task,
    mode,
    plan: p,
    cfg: cfgm.load(),
    allowWeb: opts.allowWeb !== false,
    shared: {},
    trace: []
  };

  const startedAt = Date.now();

  /* 1. ARIA parses the instruction and delegates. */
  await runAgent(registry.director, ctx);

  /* 2. The swarm works — one agent per wave (sequential) or whole waves at once (parallel). */
  const waves = (p.waves && p.waves[mode]) || p.agents.map(id => [id]);
  for (const wave of waves) {
    const live = wave.map(id => roster.get(id)).filter(Boolean);
    if (!live.length) continue;
    if (mode === 'parallel' && live.length > 1) await Promise.all(live.map(a => runAgent(a, ctx)));
    else for (const a of live) await runAgent(a, ctx);
  }

  /* 3. ARIA signs off. */
  const finalStep = await runAgent(registry.director, ctx, 'synthesize');
  const finalOutput = finalStep.result;
  const finishedAt = Date.now();

  const record = {
    id: 'agency-' + startedAt,
    task,
    mode,
    agents: p.agents,
    subtasks: p.subtasks,
    finalOutput,
    agentTrace: ctx.trace,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    ts: finishedAt
  };

  await persist(record);

  return {
    ok: true,
    id: record.id,
    task,
    mode,
    agents: p.agents,
    subtasks: p.subtasks,
    finalOutput,
    agentTrace: ctx.trace,
    startedAt,
    finishedAt,
    durationMs: record.durationMs
  };
}

/* Missions are memory too: keep the last N runs and write the report into the second brain. */
async function persist(record) {
  try {
    const db = dbm.load();
    if (!Array.isArray(db.agencyRuns)) db.agencyRuns = [];
    db.agencyRuns.unshift(record);
    db.agencyRuns = db.agencyRuns.slice(0, MAX_RUNS);
    brain.ingestNote({
      title: `Agency mission — ${snippet(record.task, 70)}`,
      content: record.finalOutput,
      source: 'agency',
      kind: 'note',
      tags: ['agency', ...record.agents],
      refId: record.id
    });
    try { brain.buildIndex(); } catch (_) {}
    await dbm.saveNow();
  } catch (e) {
    console.error('[agency:persist]', (e && e.message) || e);
  }
}

function history(limit = 20) {
  const db = dbm.load();
  const runs = Array.isArray(db.agencyRuns) ? db.agencyRuns : [];
  return runs.slice(0, Math.max(1, Number(limit) || 20));
}

module.exports = { listAgents, plan, run, history, MODES, MAX_RUNS };
