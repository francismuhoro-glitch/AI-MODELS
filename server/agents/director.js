'use strict';
/* DirectorAgent (ARIA) — the Executive Chief of Staff.
   Parses a complex multi-step instruction, delegates the sub-tasks to the specialist
   agents, then synthesises everything they produced into one executive answer. */

const cfgm = require('../config');
const { Agent, think, splitSubtasks, snippet } = require('./base');
const { dayLabel } = require('../util');

/* Order matters: research feeds analysis feeds copy. */
const PIPELINE = ['researcher', 'analyst', 'copywriter'];

class DirectorAgent extends Agent {
  constructor() {
    super({
      id: 'director',
      name: 'DirectorAgent',
      emoji: '🎩',
      role: 'Executive Chief of Staff (ARIA)',
      description: 'Parses complex multi-step instructions, delegates to the swarm and signs off the final executive output.',
      skills: ['task decomposition', 'delegation', 'synthesis']
    });
  }

  relevance() { return 1; }   // the Director always runs

  /* ---------- planning ---------- */
  /* `roster` is a Map(id → agent instance) of the available specialists. */
  plan(task, roster, requested) {
    const subtasks = splitSubtasks(task);
    const ids = [];

    const wanted = Array.isArray(requested)
      ? requested.map(x => String(x || '').toLowerCase().trim()).filter(x => x && x !== 'director')
      : null;

    if (wanted && wanted.length) {
      for (const id of PIPELINE) if (wanted.includes(id) && roster.has(id)) ids.push(id);
    }

    if (!ids.length) {
      /* Auto-delegation: score every specialist against the mission, keep the useful ones. */
      const scored = PIPELINE
        .filter(id => roster.has(id))
        .map(id => ({ id, score: roster.get(id).relevance(task) }))
        .sort((a, b) => b.score - a.score);
      for (const s of scored) if (s.score >= 0.6) ids.push(s.id);
      if (!ids.length && scored.length) ids.push(scored[0].id);
      ids.sort((a, b) => PIPELINE.indexOf(a) - PIPELINE.indexOf(b));
    }

    /* Which sub-task does each agent own? */
    const assignments = ids.map(id => {
      const agent = roster.get(id);
      const owned = subtasks.filter(s => agent.relevance(s) >= 0.6);
      return {
        id,
        name: agent.name,
        emoji: agent.emoji,
        role: agent.role,
        subtasks: owned.length ? owned : [task],
        action: this.actionLabel(id, owned.length ? owned[0] : task)
      };
    });

    /* Sequential = one agent per wave; parallel = research + analysis together, copy after. */
    const waves = { sequential: ids.map(id => [id]), parallel: [] };
    const first = ids.filter(id => id !== 'copywriter');
    const second = ids.filter(id => id === 'copywriter');
    if (first.length) waves.parallel.push(first);
    if (second.length) waves.parallel.push(second);

    return { task, subtasks, agents: ids, assignments, waves };
  }

  actionLabel(id, subtask) {
    const s = snippet(subtask, 60);
    if (id === 'researcher') return `Gather facts for “${s}”`;
    if (id === 'analyst') return `Analyse priorities, inbox & finances for “${s}”`;
    if (id === 'copywriter') return `Draft the deliverable for “${s}”`;
    return `Work on “${s}”`;
  }

  /* ---------- step 1: the delegation step in the trace ---------- */
  async run(ctx) {
    const plan = ctx.plan;
    const L = [];
    L.push(`**Mission:** ${ctx.task}`);
    L.push('');
    L.push(`**Decomposed into ${plan.subtasks.length} step${plan.subtasks.length === 1 ? '' : 's'}:**`);
    plan.subtasks.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push('');
    L.push(`**Delegated (${ctx.mode}) to ${plan.assignments.length} agent${plan.assignments.length === 1 ? '' : 's'}:**`);
    plan.assignments.forEach(a => L.push(`- ${a.emoji} **${a.name}** → ${a.action}`));
    return this.step(
      `Parsed the mission into ${plan.subtasks.length} step${plan.subtasks.length === 1 ? '' : 's'} and delegated to ${plan.assignments.length} agent${plan.assignments.length === 1 ? '' : 's'}`,
      L.join('\n'),
      { subtasks: plan.subtasks, agents: plan.agents, mode: ctx.mode }
    );
  }

  /* ---------- step N: synthesis ---------- */
  nextActions(ctx) {
    const a = ctx.shared.analysis || {};
    const r = ctx.shared.research || {};
    const d = ctx.shared.draft || null;
    const out = [];
    (a.focus || []).slice(0, 3).forEach(f => out.push(`Clear **${f}**`));
    if (a.counts && a.counts.overdue) out.push(`Reschedule or close ${a.counts.overdue} overdue item${a.counts.overdue === 1 ? '' : 's'}`);
    if (a.counts && a.counts.unread) out.push(`Triage ${a.counts.unread} unread inbox item${a.counts.unread === 1 ? '' : 's'}`);
    if (a.financial && a.financial.length) out.push(`Reconcile ${a.financial.length} open financial thread${a.financial.length === 1 ? '' : 's'}`);
    if (d) out.push(`Review and send the ${d.title.toLowerCase()} drafted above`);
    if (r.hits && !r.hits.length) out.push('Feed the brain more context (upload a document or say “remember that …”) so research lands deeper next time');
    return out.slice(0, 6);
  }

  async synthesize(ctx) {
    const cfg = cfgm.load();
    const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
    const owner = (cfg.owner && cfg.owner.name) || 'Boss';
    const a = ctx.shared.analysis || {};
    const r = ctx.shared.research || {};
    const d = ctx.shared.draft || null;
    const actions = this.nextActions(ctx);

    const evidence = [
      r.hits ? `${r.hits.length} brain record${r.hits.length === 1 ? '' : 's'}` : null,
      r.crawled && r.crawled.length ? `${r.crawled.length} web page${r.crawled.length === 1 ? '' : 's'}` : null,
      a.counts ? `${a.counts.openTasks} open actions` : null,
      a.counts ? `${a.counts.unread} unread` : null,
      a.counts && a.counts.financial ? `${a.counts.financial} financial records` : null
    ].filter(Boolean).join(' · ');

    const fallbackSummary = [
      `${ctx.plan.assignments.length} agent${ctx.plan.assignments.length === 1 ? '' : 's'} worked this mission over ${evidence || 'the available records'}.`,
      a.posture ? `Current workload reads **${a.posture}** (pressure ${a.pressure}/100).` : '',
      (a.focus && a.focus[0]) ? `The single highest-leverage move is **${a.focus[0]}**.` : '',
      d ? `${/^[aeiou]/i.test(d.title) ? 'An' : 'A'} ${d.title.toLowerCase()} is drafted and ready for your review.` : ''
    ].filter(Boolean).join(' ');

    const { text: summary, engine } = await think(
      'You are ARIA, Executive Chief of Staff. Write ONE tight executive paragraph (max 70 words) summarising the mission outcome for the principal. No headings, no bullet points, no preamble.',
      [`MISSION: ${ctx.task}`, '', 'AGENT OUTPUTS:', ...ctx.trace.map(t => `${t.agent}: ${snippet(t.result, 400)}`)].join('\n'),
      fallbackSummary
    );

    const L = [];
    L.push(`## 🤖 Agency mission report`);
    L.push(`_${dayLabel(Date.now(), tz)} · squad: ${ctx.plan.assignments.map(x => x.name).join(', ') || 'DirectorAgent'} · mode: ${ctx.mode}_`);
    L.push('');
    L.push(`**Mission:** ${ctx.task}`);
    L.push('');
    L.push(`### Executive summary`);
    L.push(summary || fallbackSummary);
    if (r.hits && r.hits.length) {
      L.push('');
      L.push('### Key findings');
      r.hits.slice(0, 5).forEach(h => L.push(`- [${h.kind}] **${h.title}** — ${snippet(h.snippet, 130)}`));
    }
    if (a.counts) {
      L.push('');
      L.push('### Desk analysis');
      L.push(`- Pressure index **${a.pressure}/100** — ${a.posture}`);
      L.push(`- ${a.counts.openTasks} open actions (${a.counts.overdue} overdue, ${a.counts.highPriority} high priority)`);
      L.push(`- ${a.counts.unread} unread emails · ${a.counts.hotMessages} priority messages · ${a.counts.financial} financial records`);
      if (a.risks && a.risks.length) L.push(`- Risks: ${a.risks.join('; ')}`);
    }
    if (d) {
      L.push('');
      L.push(`### ${d.title} (draft)`);
      L.push(d.body);
    }
    L.push('');
    L.push('### ⚡ Recommended next actions');
    L.push(actions.length ? actions.map((x, i) => `${i + 1}. ${x}`).join('\n') : `1. Nothing outstanding, ${owner} — the board is clear.`);

    const step = this.step(
      'Synthesised every agent output into the executive report',
      L.join('\n'),
      { engine, actions }
    );
    step.final = true;
    return step;
  }
}

module.exports = DirectorAgent;
module.exports.PIPELINE = PIPELINE;
