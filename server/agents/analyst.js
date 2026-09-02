'use strict';
/* AnalystAgent — scans priorities, inbox items and financial records to create an
   actionable summary. Pure deterministic reasoning over the local database. */

const dbm = require('../db');
const cfgm = require('../config');
const { Agent, money, isFinancial, snippet, PRIORITY_RANK } = require('./base');
const { dayKey, timeStr } = require('../util');

const ANALYSIS_HINTS = /\b(analy[sz]e?|analysis|priorit|inbox|triage|financ|invoice|payment|revenue|money|cash|risk|status|health|summar|report|kpi|metric|backlog|overdue|workload|next\s+actions?|action\s+items?|to-?dos?|focus|agenda|schedule|calendar|brief(?:ing)?|snapshot|scan)\b/i;

class AnalystAgent extends Agent {
  constructor() {
    super({
      id: 'analyst',
      name: 'AnalystAgent',
      emoji: '📊',
      role: 'Analysis & prioritisation',
      description: 'Scans priorities, inbox items and financial records, then turns them into an actionable summary.',
      skills: ['priority ranking', 'inbox triage', 'financial scan', 'risk flags']
    });
  }

  relevance(task) {
    let s = 0.3;
    if (ANALYSIS_HINTS.test(task)) s += 0.55;
    return Math.min(1, s);
  }

  async run(ctx) {
    const db = dbm.load();
    const cfg = cfgm.load();
    const tz = (cfg.owner && cfg.owner.timezone) || 'Africa/Nairobi';
    const now = Date.now();

    /* 1. Priorities — open action items, highest first, overdue on top. */
    const open = (db.tasks || []).filter(t => t && !t.done);
    const ranked = open.slice().sort((a, b) => {
      const oa = a.due && a.due < now ? -1 : 0;
      const ob = b.due && b.due < now ? -1 : 0;
      if (oa !== ob) return oa - ob;
      const pa = PRIORITY_RANK[a.priority] ?? 1;
      const pb = PRIORITY_RANK[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.due || Infinity) - (b.due || Infinity);
    });
    const overdue = ranked.filter(t => t.due && t.due < now);
    const highPriority = ranked.filter(t => t.priority === 'high');

    /* 2. Inbox — unread + high signal email and messages. */
    const unread = (db.emails || []).filter(e => e && !e.read)
      .sort((a, b) => (b.receivedAt || b.ts || 0) - (a.receivedAt || a.ts || 0));
    const hotEmails = unread.filter(e => e.priority === 'high' || e.priority === 'medium');
    const hotMessages = (db.messages || []).filter(m => m && (m.priority === 'high' || m.priority === 'medium'))
      .sort((a, b) => (b.sentAt || b.ts || 0) - (a.sentAt || a.ts || 0));

    /* 3. Financial records — anything money-shaped across email, chat and notes. */
    const financial = [];
    for (const e of (db.emails || [])) {
      const text = `${e.subject || ''} ${e.body || e.snippet || ''}`;
      if (isFinancial(text)) financial.push({ kind: 'email', who: e.fromName || e.from || 'unknown', label: e.subject || 'email', amounts: money(text), ts: e.receivedAt || e.ts || 0 });
    }
    for (const m of (db.messages || [])) {
      if (isFinancial(m.text)) financial.push({ kind: 'message', who: m.from || m.channel || 'unknown', label: snippet(m.text, 70), amounts: money(m.text), ts: m.sentAt || m.ts || 0 });
    }
    for (const n of (db.notes || [])) {
      const text = `${n.title || ''} ${n.content || ''}`;
      if (isFinancial(text)) financial.push({ kind: 'note', who: n.source || 'brain', label: n.title || 'note', amounts: money(text), ts: n.updatedAt || 0 });
    }
    financial.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const topFinancial = financial.slice(0, 6);

    /* 4. Today's calendar load. */
    const today = dayKey(now, tz);
    const todayEvents = (db.events || []).filter(e => e && e.start && dayKey(e.start, tz) === today).sort((a, b) => a.start - b.start);

    /* 5. A single, honest pressure score. */
    const pressure = Math.min(100, Math.round(
      overdue.length * 18 + highPriority.length * 11 + hotEmails.length * 7 + hotMessages.length * 5 + todayEvents.length * 4
    ));
    const posture = pressure >= 70 ? 'overloaded — protect deep-work time' : pressure >= 35 ? 'busy but controllable' : 'clear runway';

    const focus = ranked.slice(0, 3).map(t => t.title);
    const risks = [];
    if (overdue.length) risks.push(`${overdue.length} action item${overdue.length === 1 ? '' : 's'} past due`);
    if (hotEmails.length >= 3) risks.push(`${hotEmails.length} unread emails flagged medium/high`);
    if (topFinancial.length) risks.push(`${topFinancial.length} open financial thread${topFinancial.length === 1 ? '' : 's'} to reconcile`);
    if (todayEvents.length >= 4) risks.push(`${todayEvents.length} meetings today leave little execution time`);

    ctx.shared.analysis = {
      pressure, posture, focus, risks,
      counts: {
        openTasks: open.length, overdue: overdue.length, highPriority: highPriority.length,
        unread: unread.length, hotMessages: hotMessages.length, financial: financial.length, todayEvents: todayEvents.length
      },
      topTasks: ranked.slice(0, 5).map(t => ({ title: t.title, priority: t.priority || 'medium', due: t.due || null, context: t.context || 'day-job' })),
      inbox: hotEmails.slice(0, 5).map(e => ({ from: e.fromName || e.from, subject: e.subject, priority: e.priority || 'medium' })),
      messages: hotMessages.slice(0, 4).map(m => ({ from: m.from, channel: m.channel, text: snippet(m.text, 100) })),
      financial: topFinancial,
      events: todayEvents.slice(0, 6).map(e => ({ title: e.title, at: timeStr(e.start, tz) }))
    };

    const L = [];
    L.push(`**Pressure index: ${pressure}/100 — ${posture}.**`);
    L.push('');
    L.push(`**Priorities (${open.length} open, ${overdue.length} overdue, ${highPriority.length} high):**`);
    if (ranked.length) ranked.slice(0, 5).forEach(t => L.push(`- [${t.priority || 'medium'}${t.due && t.due < now ? ' · OVERDUE' : ''}] ${t.title}`));
    else L.push('- Nothing open — the action list is clear.');
    L.push('');
    L.push(`**Inbox (${unread.length} unread, ${hotMessages.length} priority messages):**`);
    if (hotEmails.length) hotEmails.slice(0, 5).forEach(e => L.push(`- (${e.priority || 'medium'}) **${e.fromName || e.from}** — ${e.subject}`));
    else L.push('- No unread mail needing a decision.');
    if (hotMessages.length) hotMessages.slice(0, 3).forEach(m => L.push(`- [${m.channel || 'chat'}] **${m.from}** — ${snippet(m.text, 90)}`));
    L.push('');
    L.push(`**Financial records (${financial.length} matched):**`);
    if (topFinancial.length) topFinancial.forEach(f => L.push(`- [${f.kind}] ${f.who} — ${f.label}${f.amounts.length ? ` (${f.amounts.join(', ')})` : ''}`));
    else L.push('- No invoices, payments or quotes in the current window.');
    if (todayEvents.length) {
      L.push('');
      L.push(`**Today's calendar (${todayEvents.length}):** ` + todayEvents.slice(0, 6).map(e => `${timeStr(e.start, tz)} ${e.title}`).join(' · '));
    }
    if (risks.length) {
      L.push('');
      L.push('**Risk flags:** ' + risks.join('; ') + '.');
    }

    return this.step(
      `Scanned ${open.length} priorities, ${unread.length} unread inbox items and ${financial.length} financial records`,
      L.join('\n'),
      { pressure, openTasks: open.length, unread: unread.length, financial: financial.length }
    );
  }
}

module.exports = AnalystAgent;
