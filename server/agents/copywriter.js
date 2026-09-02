'use strict';
/* CopywriterAgent — drafts emails, customer proposals and daily summaries.
   Uses the local LLM when one is reachable; otherwise composes from templates so the
   swarm ALWAYS returns a usable draft. */

const cfgm = require('../config');
const { Agent, think, snippet } = require('./base');
const { dayLabel } = require('../util');

const WRITE_HINTS = /\b(draft|write|compose|reply|respond|email|e-mail|letter|memo|proposal|pitch|quote|briefing|brief|summary|summari[sz]e|announce|newsletter|message|copy)\b/i;

function deliverableKind(task) {
  const t = String(task || '').toLowerCase();
  if (/\bproposal|pitch|quotation|quote|offer|tender\b/.test(t)) return 'proposal';
  if (/\bemail|e-mail|reply|respond|letter|follow[- ]?up note\b/.test(t)) return 'email';
  if (/\bbriefing|brief|memo|report\b/.test(t)) return 'briefing';
  return 'summary';
}

const TITLES = {
  proposal: 'Customer proposal',
  email: 'Email draft',
  briefing: 'Executive briefing',
  summary: 'Daily summary'
};

class CopywriterAgent extends Agent {
  constructor() {
    super({
      id: 'copywriter',
      name: 'CopywriterAgent',
      emoji: '✍️',
      role: 'Drafting & communication',
      description: 'Drafts emails, customer proposals and daily summaries from the swarm’s findings.',
      skills: ['email drafts', 'proposals', 'daily summaries', 'executive tone']
    });
  }

  relevance(task) {
    let s = 0.3;
    if (WRITE_HINTS.test(task)) s += 0.55;
    return Math.min(1, s);
  }

  /* Condense what the other agents produced into the copy brief. */
  material(ctx) {
    const r = ctx.shared.research || {};
    const a = ctx.shared.analysis || {};
    const facts = (r.hits || []).slice(0, 6).map(h => `- [${h.kind}] ${h.title}: ${snippet(h.snippet, 140)}`);
    (r.crawled || []).forEach(c => facts.push(`- [web] ${c.title}: ${snippet(c.snippet, 140)}`));
    const priorities = (a.topTasks || []).map(t => `- [${t.priority}] ${t.title}`);
    const inbox = (a.inbox || []).map(e => `- ${e.from}: ${e.subject}`);
    const financial = (a.financial || []).map(f => `- ${f.who} — ${f.label}${f.amounts && f.amounts.length ? ` (${f.amounts.join(', ')})` : ''}`);
    return { facts, priorities, inbox, financial, analysis: a };
  }

  template(kind, ctx, mat) {
    const cfg = cfgm.load();
    const owner = (cfg.owner && cfg.owner.name) || 'ARIA';
    const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
    const today = dayLabel(Date.now(), tz);
    const a = mat.analysis || {};
    const none = '- (nothing on record yet)';
    const facts = mat.facts.length ? mat.facts.join('\n') : none;
    const priorities = mat.priorities.length ? mat.priorities.join('\n') : none;

    if (kind === 'email') {
      return [
        `**Subject:** ${snippet(ctx.task.replace(/^\s*(draft|write|compose|send)\s+(an?\s+)?(email|e-mail|reply)?\s*(about|on|to|for)?\s*/i, '') || 'Update', 70)}`,
        '',
        'Hi there,',
        '',
        `Quick update following our review${mat.facts.length ? ' of the material on file' : ''}:`,
        '',
        facts,
        '',
        mat.priorities.length ? `Next on our side:\n${priorities}` : 'Next on our side: I will confirm the outstanding points and revert.',
        '',
        'Happy to jump on a short call if that is easier.',
        '',
        'Best regards,',
        owner
      ].join('\n');
    }

    if (kind === 'proposal') {
      return [
        `### Proposal — ${snippet(ctx.task, 80)}`,
        `_Prepared by ${owner} · ${today}_`,
        '',
        '**1. Understanding**',
        facts,
        '',
        '**2. What we propose**',
        mat.priorities.length ? priorities : '- A focused engagement covering the scope above, delivered in two phases.',
        '',
        '**3. Commercials**',
        mat.financial.length ? mat.financial.join('\n') : '- Pricing to be confirmed once scope is signed off.',
        '',
        '**4. Next step**',
        '- Confirm scope and timeline, then we issue the formal quotation.'
      ].join('\n');
    }

    if (kind === 'briefing') {
      return [
        `### Executive briefing — ${today}`,
        '',
        `**Situation.** ${a.posture ? `Workload is ${a.posture} (pressure ${a.pressure}/100).` : 'Workload assessed from the current records.'} ${mat.facts.length ? `${mat.facts.length} supporting record${mat.facts.length === 1 ? '' : 's'} reviewed.` : ''}`,
        '',
        '**What the evidence says**',
        facts,
        '',
        '**Where the pressure is**',
        priorities,
        '',
        mat.inbox.length ? `**Waiting on you**\n${mat.inbox.join('\n')}` : '**Waiting on you**\n- Inbox is clear.',
        '',
        mat.financial.length ? `**Money in motion**\n${mat.financial.join('\n')}\n` : null,
        `**Recommendation.** ${(a.focus && a.focus[0]) ? `Clear “${a.focus[0]}” first — it is the highest-leverage item on the board.` : 'No blockers: use the open runway for deep work.'}`
      ].filter(l => l !== null).join('\n');
    }

    return [
      `### Daily summary — ${today}`,
      '',
      `${a.counts ? `${a.counts.openTasks} open actions · ${a.counts.unread} unread · ${a.counts.todayEvents} meetings today.` : 'Snapshot of the current desk.'}`,
      '',
      '**Focus**',
      priorities,
      '',
      '**Context**',
      facts,
      '',
      mat.inbox.length ? `**Inbox needing a decision**\n${mat.inbox.join('\n')}` : '**Inbox needing a decision**\n- None.',
      '',
      `**Close the day by** ${(a.focus && a.focus[0]) ? `finishing “${a.focus[0]}”.` : 'clearing one deep-work block.'}`
    ].join('\n');
  }

  async run(ctx) {
    const kind = deliverableKind(ctx.task);
    const mat = this.material(ctx);
    const fallback = this.template(kind, ctx, mat);

    const system = 'You are CopywriterAgent inside ARIA OS, an executive communications writer. ' +
      'Write in clear, confident business English. No preamble, no meta-commentary — output the deliverable only. Use short paragraphs and markdown.';
    const user = [
      `MISSION: ${ctx.task}`,
      `DELIVERABLE: ${TITLES[kind]}`,
      '',
      'RESEARCH FINDINGS:',
      mat.facts.join('\n') || '(none)',
      '',
      'ANALYSIS — PRIORITIES:',
      mat.priorities.join('\n') || '(none)',
      '',
      'ANALYSIS — INBOX:',
      mat.inbox.join('\n') || '(none)',
      '',
      'ANALYSIS — FINANCIAL:',
      mat.financial.join('\n') || '(none)'
    ].join('\n');

    const { text, engine } = await think(system, user, fallback);
    const draft = text || fallback;

    ctx.shared.draft = { kind, title: TITLES[kind], body: draft, engine };

    return this.step(
      `Drafted the ${TITLES[kind].toLowerCase()} from the swarm’s findings`,
      draft,
      { kind, engine }
    );
  }
}

module.exports = CopywriterAgent;
module.exports.deliverableKind = deliverableKind;
