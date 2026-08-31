'use strict';
/* Demo connector — seeds a realistic, always-current picture of your day:
   day-job calendar, business calendar, Gmail, Outlook, Slack, WhatsApp. */
const { uid, dayKey, minutesOfDay } = require('../util');

const T = (h, m = 0) => h * 60 + m;

// Build a Date for "today at HH:MM" in Africa/Nairobi (UTC+3, fixed offset — Kenya has no DST)
const at = (dayOffset, h, m = 0) => {
  const now = new Date(Date.now() + dayOffset * 864e5);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 3, m));
  return d.getTime();
};

function events(now) {
  const today = dayKey(now, 'Africa/Nairobi');
  const mk = (day, s, e, calendar, title, location, attendees) => ({
    id: `demo-ev-${dayKey(at(day, s), 'Africa/Nairobi')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
    source: calendar === 'Business' ? 'demo' : 'demo',
    calendar, title, start: at(day, s, 0), end: at(day, e, 0), location: location || '', attendees: attendees || [], notes: ''
  });
  const dow = new Date(at(0, 12)).getUTCDay(); // 0 Sun
  const isWeekend = dow === 0 || dow === 6;
  const list = isWeekend ? [
    mk(0, 9, 10, 'Personal', 'Family brunch', 'Home'),
    mk(0, 12, 14, 'Business', 'Restock run — Gikomba market', 'Gikomba, Nairobi', ['Wanjiku (supplier)']),
    mk(0, 16, 17, 'Business', 'Weekly business review', 'Google Meet', [])
  ] : [
    mk(0, 9, 10, 'Personal', 'Morning workout', 'Home gym'),
    mk(0, 9.5, 10, 'Work', 'Daily standup — Platform team', 'Zoom', ['Team']),
    mk(0, 11, 12, 'Work', 'Client demo: dashboard v2', 'Google Meet', ['client@acme.co.ke', 'Saruni']),
    mk(0, 13, 14, 'Work', 'Lunch — skip if busy', ''),
    mk(0, 14, 15, 'Work', '1:1 with manager', 'Teams', ['Grace N.']),
    mk(0, 15.5, 16.5, 'Business', 'Supplier call: packaging prices', 'Phone', ['Kamau Supplies']),
    mk(0, 18, 19, 'Business', 'Follow up: M-Pesa reconciliation', 'Home office', [])
  ];
  // Tomorrow & yesterday for context
  list.push(
    mk(1, 10, 11, 'Work', 'Sprint planning', 'Zoom', ['Team']),
    mk(1, 15, 16, 'Business', 'Delivery: Mlolongo orders', 'Warehouse', []),
    mk(-1, 14, 15, 'Work', 'Retro', 'Zoom', ['Team'])
  );
  return list.filter(ev => ev.start > 0 && !Number.isNaN(ev.start) && ev.title);
}

function emails(now) {
  const H = 36e5;
  const mk = (hAgo, source, fromName, from, subject, body, unread = true) => ({
    id: `demo-em-${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Math.floor(hAgo)}`,
    source, from, fromName, subject, body, snippet: body.slice(0, 200),
    receivedAt: now - hAgo * H, read: !unread, labels: []
  });
  return [
    mk(2.5, 'gmail', 'Sarah Kimani', 'sarah.kimani@client.co.ke', 'URGENT: revised quotation needed before Friday',
      'Hi,\n\nThe board moved the review to Friday morning. We need the revised quotation with the new pricing tiers by Thursday EOD. Please treat this as urgent.\n\nAlso, can you confirm the delivery schedule for the Mlolongo order?\n\nRegards,\nSarah Kimani\nProcurement Lead'),
    mk(5, 'gmail', 'Kamau Supplies Ltd', 'accounts@kamausupplies.co.ke', 'Invoice #KS-2841 — payment due in 7 days',
      'Dear customer,\n\nPlease find attached Invoice #KS-2841 for packaging materials. Total: KES 46,500. Payment due within 7 days via M-Pesa Paybill or bank transfer.\n\nKindly confirm receipt.'),
    mk(9, 'outlook', 'Grace Njeri', 'grace.n@dayjob.com', 'Prep for our 1:1 — agenda',
      'Hi,\n\nAgenda for our 1:1 today: Q3 goals check-in, the platform migration timeline, and your training budget request. Please add anything you want to discuss.\n\nGrace'),
    mk(14, 'gmail', 'Jumia Sellers', 'no-reply@jumia.co.ke', 'Your weekly seller performance report',
      'Weekly report: Your store received 34 orders this week (up 12%). Top seller: Wireless Earbuds Pro. 2 returns pending. Payout of KES 128,400 processed to your bank.'),
    mk(20, 'outlook', 'IT Helpdesk', 'helpdesk@dayjob.com', 'Action required: password expires in 3 days',
      'Your domain password expires in 3 days. Please change it via the self-service portal to avoid losing access during sprint planning.'),
    mk(26, 'gmail', 'Daniel Otieno', 'daniel.otieno@partner.co.ke', 'Partnership follow-up — our conversation last week',
      'Hey,\n\nFollowing up on our chat about the distribution partnership. I drafted the revenue-share terms we discussed (30/70). Can we get 30 minutes this week to review? Thursday or Friday works for me.\n\nDaniel'),
    mk(30, 'gmail', 'Bank: Equity', 'alerts@equitybank.co.ke', 'Transaction alert: KES 85,000 received',
      'Credit alert: KES 85,000.00 received from ACME LTD - REF: INVOICE 2026-08. Available balance updated. This is an automated message.', false),
    mk(34, 'outlook', 'HR People Team', 'hr@dayjob.com', 'Reminder: complete benefits enrollment by Sept 5',
      'Friendly reminder to complete your 2026 benefits enrollment before September 5. Untouched enrolling defaults to the standard medical plan.')
  ];
}

function messages(now) {
  const H = 36e5;
  const mk = (hAgo, source, channel, from, text, unread = true) => ({
    id: `demo-msg-${Math.floor(hAgo * 4)}-${source}-${channel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    source, channel, from, text, sentAt: now - hAgo * H, read: !unread
  });
  return [
    mk(1, 'whatsapp', 'Business — Suppliers KE', 'Wanjiku (Kikomba)', 'Good morning. The bales you wanted arrived this morning. Quality is A-grade. Should I reserve 10 for you? Going fast 🏃🏽'),
    mk(1.5, 'slack', '#eng-platform', 'Brian M.', 'Deploy for the payments fix is staged. Can you approve the pipeline when you get a chance? Staging looks green.'),
    mk(2, 'whatsapp', 'Business — Customers', 'Mercy W.', 'Hello, has my order for 20 pieces been dispatched? I need them before Saturday market day.'),
    mk(3, 'slack', '#general', 'Grace N.', 'Reminder: leadership sync moved to 2pm today, same link. Please review the Q3 doc before we meet.'),
    mk(4, 'whatsapp', 'Family', 'Mum', 'My son, hope week is going well. We thank God. Call me when you are free today 🙏'),
    mk(6, 'slack', '#eng-platform', 'CI Bot', 'Pipeline #4213 FAILED on integration tests (3 failures). First failure: checkout-flow.spec.ts:88 — assertion on cart total.'),
    mk(8, 'whatsapp', 'Business — Suppliers KE', 'Kamau Supplies', 'Bro, the invoice balance of 46,500 — we can do a part payment if cash is tight this month. Just keep the business growing 💪'),
    mk(10, 'slack', 'DM — Saruni', 'Saruni L.', 'Nice demo prep! One thing — the client asked last time about offline mode. Should we add a slide for it?'),
    mk(12, 'whatsapp', 'Business — Customers', 'Otieno K.', 'Mpesa imetumwa. KES 12,000 for the last batch. Asante sana. Next order next week.')
  ];
}

function sync(ctx, now = Date.now()) {
  const db = ctx.db || ctx;
  for (const ev of events(now)) db.upsert('events', ev);
  for (const em of emails(now)) db.upsert('emails', em);
  for (const ms of messages(now)) db.upsert('messages', ms);
  return { events: events(now).length, emails: 8, messages: 9 };
}

module.exports = { name: 'demo', label: 'Demo data', sync };
