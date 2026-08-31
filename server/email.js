'use strict';
/* Email delivery of the morning brief via SMTP (Gmail app password works great). */
async function sendBrief(cfg, brief) {
  if (!cfg.smtp.host || !cfg.smtp.user || !cfg.smtp.to) return { skipped: 'SMTP not configured — set it in Settings → Brief delivery' };
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: cfg.smtp.host, port: +cfg.smtp.port || 587, secure: !!cfg.smtp.secure,
      auth: { user: cfg.smtp.user, pass: cfg.smtp.pass }
    });
    const html = mdToHtml(brief.markdown);
    await transport.sendMail({
      from: `"ARIA OS" <${cfg.smtp.user}>`, to: cfg.smtp.to,
      subject: `☀️ Morning Brief — ${brief.date}`, text: brief.markdown, html
    });
    return { sent: true, to: cfg.smtp.to };
  } catch (e) { return { error: e.message }; }
}

/* Tiny markdown → HTML for email clients */
function mdToHtml(md) {
  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  const lines = md.split('\n'); const out = []; let inList = false;
  for (const line of lines) {
    const li = line.match(/^[-\d.]+ (.*)$/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (line.startsWith('_') && line.endsWith('_')) out.push(`<p><em>${inline(line.slice(1, -1))}</em></p>`);
    else if (line.trim() === '---') out.push('<hr>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

module.exports = { sendBrief, mdToHtml };
