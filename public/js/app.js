/* ARIA OS — frontend app */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const key = localStorage.getItem('aria.key');
  if (key) headers['X-ARIA-Key'] = key;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
const POST = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms);
}
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal').hidden = false; $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; }; }
function closeModal() { $('#modal').hidden = true; }

/* tiny markdown renderer */
function md(src) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  const lines = String(src || '').split('\n'); const out = []; let list = false;
  for (const line of lines) {
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(line.replace(/^[-*] /, '').replace(/^\d+\. /, ''))}</li>`); continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    const h = line.match(/^(#{1,4}) (.*)$/);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim() === '---') out.push('<hr>');
    else if (/^_.+_$/.test(line.trim())) out.push(`<p><em>${inline(line.trim().slice(1, -1))}</em></p>`);
    else if (line.trim().startsWith('## ⚡')) out.push(`<div class="one-thing">${inline(line.replace(/^## ⚡ The one thing$/, ''))}</div>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

const fmtTime = (ts, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
const fmtDay = (ts, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ts));
const fmtAgo = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now'; if (m < 60) return `${m}m`; if (m < 1440) return `${Math.round(m / 60)}h`; return `${Math.round(m / 1440)}d`;
};
const prioDot = (p) => `<span class="dot-p ${p || 'low'}"></span>`;
const ctxChip = (ctx) => ctx === 'business' ? '<span class="chip green">business</span>' : '<span class="chip blue">work</span>';

/* ---------------- sound & ARIA's voice ---------------- */
const Sound = {
  on: localStorage.getItem('aria.sound') !== '0',
  ctx: null,
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  tone(freq, t0, dur, type = 'sine', gain = 0.12) {
    const ctx = this.ensure(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime + t0);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + dur + 0.05);
  },
  ding() { if (!this.on) return; this.tone(880, 0, .35); this.tone(1318.5, .12, .5); },
  chirp() { if (!this.on) return; this.tone(659.3, 0, .12, 'triangle', .09); this.tone(987.8, .09, .22, 'triangle', .09); },
  pop() { if (!this.on) return; this.tone(523.3, 0, .09, 'sine', .06); },
  voice(file) {
    if (!this.on) return Promise.resolve(false);
    return new Promise(res => { try { const a = new Audio(file); a.volume = .95; a.onended = () => res(true); a.play().then(() => {}).catch(() => res(false)); } catch (_) { res(false); } });
  },
  morning() { return this.voice('/audio/morning.mp3'); },
  priorityAlert() { this.ding(); return this.voice('/audio/priority.mp3'); },
  toggle() { this.on = !this.on; localStorage.setItem('aria.sound', this.on ? '1' : '0'); this.renderChip(); return this.on; },
  label() { return this.on ? '🔊 Sound on' : '🔇 Sound off'; },
  renderChip() {
    $$('.js-sound').forEach(b => {
      b.textContent = this.on ? '🔊' : '🔇';
      b.title = this.on ? 'Sound on — click to mute' : 'Muted — click to unmute';
    });
  }
};

/* ---------------- install (PWA) ---------------- */
const Installer = {
  deferred: null,
  init() {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.deferred = e; this.render(); });
    window.addEventListener('appinstalled', () => { this.deferred = null; this.render(); toast('📱 ARIA OS installed — check your home screen'); });
    this.render();
  },
  standalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; },
  async prompt() {
    if (this.deferred) {
      this.deferred.prompt();
      const r = await this.deferred.userChoice;
      this.deferred = null; this.render();
      if (r.outcome === 'accepted') toast('Installing ARIA OS…');
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) openModal(`<h2 style="font-size:18px;margin-bottom:12px">📲 Install ARIA OS on iPhone / iPad</h2>
      <ol style="line-height:2.1;color:var(--dim);font-size:14px;padding-left:20px">
        <li>Open this page in <strong style="color:var(--text)">Safari</strong></li>
        <li>Tap the <strong style="color:var(--text)">Share</strong> button <span style="opacity:.6">(square with an arrow up)</span></li>
        <li>Scroll down and tap <strong style="color:var(--text)">Add to Home Screen</strong></li>
        <li>Tap <strong style="color:var(--text)">Add</strong> — done ✨</li>
      </ol>
      <p style="color:var(--faint);font-size:12.5px;margin-top:12px">ARIA will run full-screen like a native app — morning brief, second brain and assistant, with voice.</p>`);
    else openModal(`<h2 style="font-size:18px;margin-bottom:10px">📲 Install ARIA OS</h2>
      <p style="color:var(--dim);font-size:13.5px;line-height:1.8">Open your browser menu → <strong style="color:var(--text)">Install app</strong> / <strong style="color:var(--text)">Add to Home screen</strong>.<br>On Chrome desktop, use the install icon in the address bar.<br><br>The installed app works offline for your latest brief and greets you with voice every morning.</p>`);
  },
  render() {
    $$('.js-install').forEach(b => {
      b.hidden = this.standalone();
      b.textContent = '📲'; b.title = 'Install ARIA OS on this device';
    });
  }
};

/* ---------------- push notifications (morning wake-up) ---------------- */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const PushClient = {
  async subscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Push not supported in this browser');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notification permission was denied');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    if (!publicKey) return toast('Server push not configured');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await POST('/api/push/subscribe', sub);
    toast('🔔 Morning notifications enabled — brief arrives at ' + (STATE?.wakeTime || '06:00'));
  },
  async test() { await POST('/api/push/test'); toast('Test notification sent — check your device'); }
};

/* ---------------- state ---------------- */
let STATE = null; let SETTINGS = null; let CONNECTORS = [];

let lastHighSeen = null;
async function refreshState() {
  STATE = await api('/api/state');
  const high = STATE.inbox.filter(e => e.priority === 'high' && !e.read).length + STATE.messages.filter(m => m.priority === 'high' && !m.read).length;
  if (lastHighSeen !== null && high > lastHighSeen) Sound.priorityAlert();
  lastHighSeen = high;
  return STATE;
}

function updateSidebar() {
  if (!STATE) return;
  const b = $('#nav-unread');
  if (STATE.unread > 0) { b.hidden = false; b.textContent = STATE.unread; } else b.hidden = true;
  const eng = $('#engine-chip');
  const dot = STATE.stats.engine === 'ollama' ? '<span class="dot on"></span>' : '<span class="dot off"></span>';
  eng.innerHTML = `${dot}${STATE.stats.engine === 'ollama' ? 'local LLM · ollama' : 'offline engine'}`;
  $('#sync-chip').textContent = STATE.stats.lastSync ? `synced ${fmtAgo(STATE.stats.lastSync)} ago` : 'never synced';
  Sound.renderChip(); Installer.render();
}

/* ---------------- router ---------------- */
const routes = { hub: viewHub, briefs: viewBriefs, calendar: viewCalendar, inbox: viewInbox, messages: viewMessages, brain: viewBrain, assistant: viewAssistant, settings: viewSettings };
let assistantInit = false;

window.addEventListener('hashchange', route);
async function route() {
  const view = (location.hash.replace('#/', '') || 'hub').split('?')[0];
  $$('.nav-item, .tabbar a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  const main = $('#main');
  main.innerHTML = '<div class="empty" style="padding:60px"><span class="spin">◌</span> loading…</div>';
  try { await (routes[view] || viewHub)(main, view); }
  catch (e) { main.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; }
  updateSidebar();
}

/* ---------------- views ---------------- */

/* ===== HUB ===== */
async function viewHub(main) {
  await refreshState();
  const s = STATE;
  const hour = +fmtTime(Date.now(), s.timezone).split(':')[0];
  const greetWord = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const nowLine = nowLineHtml(s.events, s.timezone);

  main.innerHTML = `
    <div class="greet">
      <div><h1>${greetWord}, ${esc(s.owner.name)}.</h1>
      <div class="date">${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: s.timezone }).format(Date.now())} · ${s.events.length} event${s.events.length === 1 ? '' : 's'} · ${s.unread} unread · ${s.tasks.length} open actions</div></div>
      <div class="head-actions">
        <button class="btn js-sound" title="Toggle sound">🔊</button>
        <button class="btn js-install" title="Install on this device">📲</button>
        <button class="btn" id="btn-sync">↻ Sync now</button>
        <button class="btn primary" id="btn-brief">✦ Generate brief</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="num">${s.stats.notes}</div><div class="lbl">brain notes</div></div>
      <div class="stat"><div class="num">${s.stats.briefs}</div><div class="lbl">briefs archived</div></div>
      <div class="stat"><div class="num">${s.stats.emails}</div><div class="lbl">emails tracked</div></div>
      <div class="stat"><div class="num">${s.stats.messages}</div><div class="lbl">messages</div></div>
      <div class="stat"><div class="num">${s.stats.events}</div><div class="lbl">calendar items</div></div>
    </div>

    <div class="grid c3">
      <div>
        <div class="card brief-card" id="brief-card"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card"><h3>Today's schedule <span class="right">${s.events.length} items</span></h3>
          <div class="timeline">${s.events.length ? s.events.map(tlItem).join('') : '<div class="empty">No meetings today 🌿</div>'}</div>
          ${nowLine}
        </div>
        <div class="card"><h3>Action items <span class="right">${s.tasks.length} open</span></h3>
          <div id="hub-tasks">${s.tasks.length ? s.tasks.map(taskRow).join('') : '<div class="empty">Nothing open. Ask ARIA what to focus on.</div>'}</div>
        </div>
      </div>
    </div>

    <div class="grid c2" style="margin-top:16px">
      <div class="card"><h3>Priority inbox <span class="right"><a href="#/inbox" style="color:var(--accent);text-decoration:none">open inbox →</a></span></h3>
        ${s.inbox.slice(0, 6).map(emailRow).join('') || '<div class="empty">Inbox zero ✨</div>'}
      </div>
      <div class="card"><h3>Latest messages <span class="right"><a href="#/messages" style="color:var(--accent);text-decoration:none">open messages →</a></span></h3>
        ${s.messages.slice(0, 7).map(msgRow).join('') || '<div class="empty">No messages.</div>'}
      </div>
    </div>`;

  renderBriefCard(s.brief);
  // greet with voice when a fresh brief is on the hub (once per session; browser may require a tap first)
  if (s.brief && Date.now() - s.brief.generatedAt < 10 * 60_000 && !sessionStorage.getItem('aria.greeted')) {
    sessionStorage.setItem('aria.greeted', '1');
    Sound.morning();
  }
  $('#btn-sync').onclick = async (e) => { e.target.disabled = true; e.target.textContent = '↻ syncing…'; await POST('/api/sync'); await route(); toast('Connectors synced'); Sound.pop(); };
  $('#btn-brief').onclick = async (e) => { e.target.disabled = true; e.target.textContent = '✦ composing…'; const b = await POST('/api/brief/generate'); await refreshState(); renderBriefCard(STATE.brief); e.target.disabled = false; e.target.textContent = '✦ Generate brief'; toast(b.meta ? `Brief ready — ${b.meta.hot} urgent items flagged` : 'Brief ready'); if (b.meta && b.meta.hot > 0) Sound.priorityAlert(); };
  bindTaskToggles('#hub-tasks');
  $$('.row[data-email]', main).forEach(r => r.onclick = () => openEmail(r.dataset.email));
}

function nowLineHtml(events, tz) {
  const nowMin = (() => { const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); const h = +f.find(p => p.type === 'hour').value; const m = +f.find(p => p.type === 'minute').value; return h * 60 + m; })();
  const next = events.find(e => { const d = new Date(e.start); const mins = +new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(d) * 60 + +new Intl.DateTimeFormat('en-GB', { timeZone: tz, minute: '2-digit' }).format(d); return mins > nowMin; });
  if (!next) return '';
  return `<div style="margin-top:12px;font-size:12px;color:var(--dim);border-top:1px solid var(--border);padding-top:10px">⏭ next: <strong style="color:var(--text)">${esc(next.title)}</strong> at ${fmtTime(next.start, tz)}</div>`;
}

function tlItem(e) {
  const cal = (e.calendar || 'Work').toLowerCase();
  return `<div class="tl-item ${new Date(e.end) < Date.now() ? 'past' : ''}">
    <div class="tl-time">${fmtTime(e.start, STATE.timezone)}</div>
    <div class="tl-bar ${cal}"></div>
    <div><div class="tl-title">${esc(e.title)}</div>
    <div class="tl-meta">${esc(e.calendar)}${e.location ? ' · ' + esc(e.location) : ''}${(e.attendees || []).length ? ' · ' + e.attendees.length + ' att.' : ''}</div></div>
  </div>`;
}

function renderBriefCard(brief) {
  const el = $('#brief-card'); if (!el) return;
  if (!brief) { el.innerHTML = `<h3>☀️ Morning Brief</h3><div class="empty">No brief yet. Hit <strong>Generate brief</strong> — or wait for ${esc(STATE.wakeTime)} tomorrow morning.</div>`; return; }
  const briefMd = md(brief.markdown).replace('<h2>⚡ The one thing</h2>', '').replace(/<p>The one thing<\/p>/, '');
  el.innerHTML = `<div class="brief-head"><h3 style="margin:0">☀️ Morning Brief <span class="right">${esc(brief.date)} · ${esc(brief.trigger || 'manual')}</span></h3>
    <span style="display:flex;gap:7px"><button class="btn small" id="btn-hear" title="Play ARIA's voice greeting">🔊 hear it</button>
    <button class="btn small" onclick="location.hash='#/briefs'">archive →</button></span></div>
    <div class="md">${briefMd}</div>`;
  $('#btn-hear').onclick = () => Sound.morning();
}

/* ===== BRIEFS ===== */
async function viewBriefs(main) {
  const briefs = await api('/api/briefs');
  main.innerHTML = `<div class="view-head"><div><h1>Morning Briefs</h1><div class="sub">Every day at ${esc((await api('/api/settings')).wakeTime)} · dashboard + email</div></div>
    <button class="btn primary" id="btn-brief2">✦ Generate now</button>
    <button class="btn" id="btn-hear2" title="Play ARIA's voice greeting">🔊</button></div>
    <div class="grid">${briefs.length ? briefs.map(b => `
      <div class="card" style="cursor:pointer" onclick="openBrief('${b.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <strong>☀️ ${esc(b.date)}</strong>
          <span style="display:flex;gap:7px">
            ${b.meta ? `<span class="chip blue">${b.meta.events} events</span><span class="chip ${b.meta.hot ? 'red' : 'green'}">${b.meta.hot} urgent</span><span class="chip purple">${b.meta.emails} unread</span>` : ''}
            ${b.emailStatus?.sent ? '<span class="chip green">emailed</span>' : b.emailStatus?.skipped ? '<span class="chip yellow">email off</span>' : b.emailStatus?.error ? `<span class="chip red">email err</span>` : ''}
          </span>
        </div>
        <div class="note-snip" style="margin-top:8px">${esc((b.markdown || '').replace(/[#*_]/g, '').slice(0, 220))}…</div>
      </div>`).join('') : '<div class="card empty">No briefs yet — generate your first one.</div>'}</div>`;
  $('#btn-brief2').onclick = async (e) => { e.target.disabled = true; e.target.textContent = '✦ composing…'; await POST('/api/brief/generate'); route(); toast('Brief generated'); };
  $('#btn-hear2').onclick = () => Sound.morning();
}

window.openBrief = async (id) => {
  const b = await api(`/api/briefs/${id}`);
  openModal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="font-size:18px">☀️ ${esc(b.date)}</h2><button class="btn small" onclick="closeModal()">close</button></div><div class="md">${md(b.markdown)}</div>`);
};
window.closeModal = closeModal;

/* ===== CALENDAR ===== */
async function viewCalendar(main) {
  const events = await api('/api/events?days=8');
  const tz = STATE.timezone;
  const byDay = {};
  for (const e of events) { const k = fmtDay(e.start, tz); (byDay[k] = byDay[k] || []).push(e); }
  main.innerHTML = `<div class="view-head"><div><h1>Calendar</h1><div class="sub">Every calendar, one timeline — work, business, personal</div></div><button class="btn" id="btn-sync2">↻ Sync</button></div>
    ${Object.entries(byDay).map(([day, evs]) => `<div class="card" style="margin-bottom:14px"><h3>${esc(day)} <span class="right">${evs.length} items</span></h3>
      <div class="timeline">${evs.map(tlItem).join('')}</div></div>`).join('') || '<div class="card empty">No events.</div>'}`;
  $('#btn-sync2').onclick = async () => { await POST('/api/sync'); route(); toast('Synced'); };
}

/* ===== INBOX ===== */
let inboxFilter = 'all';
async function viewInbox(main) {
  const emails = await api('/api/emails');
  const filtered = emails.filter(e => inboxFilter === 'all' || e.source === inboxFilter || (inboxFilter === 'urgent' && e.priority === 'high'));
  main.innerHTML = `<div class="view-head"><div><h1>Inbox</h1><div class="sub">${emails.filter(e => !e.read).length} unread of ${emails.length} — Gmail + Outlook unified</div></div>
    <div class="head-actions">${['all', 'gmail', 'outlook', 'urgent'].map(f => `<button class="btn small ${inboxFilter === f ? 'primary' : ''}" data-f="${f}">${f}</button>`).join('')}</div></div>
    <div class="card">${filtered.map(emailRow).join('') || '<div class="empty">Nothing here.</div>'}</div>`;
  $$('button[data-f]', main).forEach(b => b.onclick = () => { inboxFilter = b.dataset.f; viewInbox(main); });
  $$('.row[data-email]', main).forEach(r => r.onclick = () => openEmail(r.dataset.email, main));
}

function emailRow(e) {
  return `<div class="row ${e.read ? '' : 'unread'}" data-email="${esc(e.id)}">${prioDot(e.priority)}
    <div class="r-main"><div class="r-title">${esc(e.subject)}</div>
    <div class="r-sub">${esc(e.fromName || e.from)} · ${ctxChip(e.context)} <span style="opacity:.6">${esc(e.source)}</span></div></div>
    <div class="r-time">${fmtAgo(e.receivedAt)}</div></div>`;
}

async function openEmail(id, refreshMain) {
  const emails = await api('/api/emails'); const e = emails.find(x => x.id === id); if (!e) return;
  if (!e.read) { await POST(`/api/emails/${e.id}/read`); }
  openModal(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:6px">
    <h2 style="font-size:17px;line-height:1.35">${esc(e.subject)}</h2>
    <button class="btn small" onclick="closeModal()">✕</button></div>
    <div style="color:var(--dim);font-size:12.5px;margin-bottom:12px">${esc(e.fromName || '')} &lt;${esc(e.from)}&gt; · ${esc(e.source)} · ${fmtDay(e.receivedAt, STATE.timezone)} ${fmtTime(e.receivedAt, STATE.timezone)} · ${ctxChip(e.context)} ${e.priority === 'high' ? '<span class="chip red">urgent</span>' : ''}</div>
    <div style="white-space:pre-wrap;font-size:13.5px;color:var(--text)">${esc(e.body)}</div>
    <div style="margin-top:16px;display:flex;gap:8px"><button class="btn primary small" id="em-ask">✦ Ask ARIA to draft a reply</button></div><div id="em-draft" class="md" style="margin-top:10px"></div>`);
  $('#em-ask').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = '✦ drafting…';
    const r = await POST('/api/assistant', { message: `Draft a concise professional reply to this email:\nSubject: ${e.subject}\nFrom: ${e.fromName} <${e.from}>\n\n${e.body}` });
    $('#em-draft').innerHTML = md(r.reply);
  };
  if (refreshMain) viewInbox(refreshMain); else route();
  updateSidebar();
}

/* ===== MESSAGES ===== */
async function viewMessages(main) {
  const msgs = await api('/api/messages');
  main.innerHTML = `<div class="view-head"><div><h1>Messages</h1><div class="sub">Slack + WhatsApp, unified feed</div></div><button class="btn" id="btn-sync3">↻ Sync</button></div>
    <div class="card">${msgs.map(msgRow).join('') || '<div class="empty">No messages.</div>'}</div>`;
  $('#btn-sync3').onclick = async () => { await POST('/api/sync'); route(); toast('Synced'); };
}

function msgRow(m) {
  const icon = m.source === 'whatsapp' ? '🟢' : m.source === 'slack' ? '🟣' : '⚪';
  return `<div class="row" data-msg="${esc(m.id)}">${prioDot(m.priority)}
    <div class="r-main"><div class="r-title">${icon} ${esc(m.channel)}</div>
    <div class="r-sub">${esc(m.from)}: ${esc(m.text).slice(0, 130)}</div></div>
    <div class="r-time">${fmtAgo(m.sentAt)}</div></div>`;
}

/* ===== BRAIN ===== */
async function viewBrain(main) {
  const notes = await api('/api/notes');
  main.innerHTML = `<div class="view-head"><div><h1>Second Brain</h1><div class="sub">${notes.length} notes · grows automatically from briefs, emails & messages</div></div></div>
    <div class="card capture-box"><h3>⚡ Capture — teach your brain anything</h3>
      <div class="form-grid" style="grid-template-columns:1fr 2fr auto;align-items:end">
        <label class="field">Title (optional)<input id="cap-title" placeholder="e.g. Supplier pricing playbook"></label>
        <label class="field">Paste anything — an idea, a client brief, a lesson learned<textarea id="cap-content" placeholder="Paste or type… it gets indexed, topic-tagged and searchable forever."></textarea></label>
        <button class="btn primary" id="cap-save" style="height:40px">＋ Remember</button>
      </div></div>
    <div class="card" style="margin-top:14px"><h3>🔎 Search everything</h3>
      <input id="brain-q" placeholder="Ask your brain… e.g. “Kamau invoice terms”, “client demo feedback”, “M-Pesa reconciliation”">
      <div class="search-results" id="brain-results"></div></div>
    <div class="notes-grid" id="notes-grid">${notes.map(noteCard).join('') || '<div class="card empty">The brain is empty. Capture your first note above ↑</div>'}</div>`;
  $('#cap-save').onclick = async () => {
    const content = $('#cap-content').value.trim(); if (!content) return toast('Write something first');
    await POST('/api/notes', { title: $('#cap-title').value.trim(), content });
    toast('🧠 Remembered'); route();
  };
  let t; $('#brain-q').oninput = (e) => { clearTimeout(t); t = setTimeout(async () => {
    const q = e.target.value.trim(); if (!q) { $('#brain-results').innerHTML = ''; return; }
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $('#brain-results').innerHTML = hits.map(h => `<div class="sr" data-ref="${esc(h.kind)}:${esc(h.refId || '')}">
      <div class="sr-title">${esc(h.title)}</div><div class="sr-snip">${esc(h.snippet)}</div>
      <div class="sr-meta"><span class="chip blue">${h.kind}</span><span>score ${h.score}</span><span>${fmtAgo(h.ts)} ago</span></div></div>`).join('') || '<div class="empty">No matches yet.</div>';
  }, 250); };
  $$('.note-card', main).forEach(c => c.onclick = () => openNote(notes.find(n => n.id === c.dataset.id)));
}

function noteCard(n) {
  return `<div class="note-card" data-id="${esc(n.id)}">
    <div class="note-title">${esc(n.title)}</div>
    <div class="note-snip">${esc(n.content).slice(0, 150)}</div>
    <div class="note-tags">${(n.tags || []).map(t => `<span class="chip ${t === 'business' ? 'green' : t === 'work' ? 'blue' : ''}">${esc(t)}</span>`).join('')}${(n.topics || []).slice(0, 3).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--faint)">${esc(n.source)} · ${fmtAgo(n.updatedAt)} ago</div></div>`;
}

async function openNote(n) {
  openModal(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px">
    <h2 style="font-size:17px">${esc(n.title)}</h2>
    <div style="display:flex;gap:7px"><button class="btn small" id="note-del">🗑</button><button class="btn small" onclick="closeModal()">✕</button></div></div>
    <div style="font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-bottom:12px">${esc(n.source)} · created ${new Date(n.createdAt).toLocaleString('en-GB')}</div>
    <div style="white-space:pre-wrap;font-size:13.5px">${esc(n.content)}</div>
    <div class="note-tags" style="margin-top:12px">${(n.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>`);
  $('#note-del').onclick = async () => { await api(`/api/notes/${n.id}`, { method: 'DELETE' }); closeModal(); route(); toast('Note deleted'); };
}

/* ===== ASSISTANT ===== */
async function viewAssistant(main) {
  const history = await api('/api/assistant/history');
  const ai = await api('/api/ai/status');
  main.innerHTML = `<div class="view-head"><div><h1>Executive Assistant</h1><div class="sub">Reasons over your real calendar, inbox, messages & brain</div></div>
    <span class="chip ${ai.activeEngine === 'ollama' ? 'green' : 'yellow'}">${ai.activeEngine === 'ollama' ? `🟢 local LLM · ${esc(ai.model || '')}` : '🟡 built-in offline engine'}</span></div>
    <div class="card chat-wrap">
      <div class="chat-scroll" id="chat-scroll">
        ${history.length ? history.map(chatMsg).join('') : welcomeMsg(ai)}
      </div>
      <div class="suggests">${['What does my day look like?', 'What are my priorities?', 'How is my inbox?', 'Business snapshot', 'What do you know about suppliers?'].map(s => `<button class="btn" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <div class="chat-input"><input id="chat-in" placeholder="Ask ARIA anything about your day, work or business…" autocomplete="off"><button class="btn primary" id="chat-send">Send ⏎</button></div>
    </div>`;
  const scroll = $('#chat-scroll'); scroll.scrollTop = scroll.scrollHeight;
  const send = async () => {
    const input = $('#chat-in'); const text = input.value.trim(); if (!text) return;
    input.value = ''; Sound.pop();
    scroll.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="md"><p>${esc(text)}</p></div></div><div class="msg aria" id="aria-typing"><span class="typing"><i></i><i></i><i></i></span></div>`);
    scroll.scrollTop = scroll.scrollHeight;
    try {
      const r = await POST('/api/assistant', { message: text });
      $('#aria-typing').outerHTML = `<div class="msg aria"><div class="md">${md(r.reply)}</div><div class="engine-tag">${esc(r.engine)}</div></div>`;
    } catch (e) {
      $('#aria-typing').outerHTML = `<div class="msg aria"><div class="md"><p>⚠️ ${esc(e.message)}</p></div></div>`;
    }
    scroll.scrollTop = scroll.scrollHeight;
  };
  $('#chat-send').onclick = send;
  $('#chat-in').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  $$('.suggests .btn', main).forEach(b => b.onclick = () => { $('#chat-in').value = b.dataset.s; send(); });
}

function chatMsg(c) {
  if (c.role === 'user') return `<div class="msg user"><div class="md"><p>${esc(c.content)}</p></div></div>`;
  return `<div class="msg aria"><div class="md">${md(c.content)}</div>${c.engine ? `<div class="engine-tag">${esc(c.engine)}</div>` : ''}</div>`;
}
function welcomeMsg(ai) {
  return `<div class="msg aria"><div class="md">
    <p><strong>${ai.activeEngine === 'ollama' ? 'Running on your local Ollama model — private, free, on-device.' : 'Running my built-in offline engine.'}</strong> ${ai.activeEngine === 'ollama' ? '' : 'For full free-form reasoning, install <code>ollama</code>, pull a model, and set it in Settings — everything stays on your machine.'}</p>
    <p>I can brief you on the day, rank priorities, triage your inbox, summarize Slack & WhatsApp, and answer from your second brain.</p>
    <p><em>Try a suggestion below, or just ask.</em></p></div></div>`;
}

/* ===== SETTINGS ===== */
async function viewSettings(main) {
  const [s, conns] = await Promise.all([api('/api/settings'), api('/api/connectors')]);
  SETTINGS = s; CONNECTORS = conns;
  const connMeta = {
    demo: ['🧪', 'Demo data', 'Realistic sample day (day job + business). Turn off once your real accounts are connected.'],
    google: ['📧', 'Gmail + Google Calendar', 'One-time OAuth setup: Google Cloud project → enable Gmail + Calendar APIs → OAuth client (redirect http://localhost:3111/oauth/google) → generate refresh token → paste below.'],
    microsoft: ['📩', 'Outlook Mail + Calendar', 'Azure app registration → delegated Mail.Read + Calendars.Read → device-code access token → paste below.'],
    slack: ['💬', 'Slack', 'Create a User Token (xoxp-) at api.slack.com/apps with scopes: channels:read, channels:history, im:history, groups:history — paste below.'],
    whatsapp: ['🟢', 'WhatsApp Business (Cloud API)', 'developers.facebook.com → WhatsApp product → access token + phone number ID. Inbound webhook: /api/ingest/whatsapp']
  };
  main.innerHTML = `<div class="view-head"><div><h1>Settings</h1><div class="sub">Your OS, your rules</div></div><button class="btn primary" id="set-save">💾 Save all</button></div>
    <div class="grid c2">
      <div class="card"><h3>⏰ Rhythm</h3><div class="form-grid">
        <label class="field">Your name<input id="s-name" value="${esc(s.owner.name)}"></label>
        <label class="field">Wake time (brief ready at)<input id="s-wake" type="time" value="${esc(s.wakeTime)}"></label>
        <label class="field">Timezone<input id="s-tz" value="${esc(s.owner.timezone)}"></label>
        <label class="field">Location label<input id="s-loc-label" value="${esc(s.owner.location.label)}"></label>
        <label class="field">Latitude<input id="s-lat" value="${s.owner.location.lat}"></label>
        <label class="field">Longitude<input id="s-lon" value="${s.owner.location.lon}"></label>
      </div><p style="color:var(--faint);font-size:12px;margin-top:10px">Every day at wake time ARIA syncs everything, writes your brief, and emails it if SMTP is set.</p></div>

      <div class="card"><h3>🧠 AI engine</h3><div class="form-grid">
        <label class="field">Provider<select id="s-provider"><option value="auto" ${s.llm.provider === 'auto' ? 'selected' : ''}>Auto (Ollama → fallback offline)</option><option value="ollama" ${s.llm.provider === 'ollama' ? 'selected' : ''}>Ollama only</option><option value="offline" ${s.llm.provider === 'offline' ? 'selected' : ''}>Offline engine only</option></select></label>
        <label class="field">Ollama URL<input id="s-ourl" value="${esc(s.llm.ollamaUrl)}"></label>
        <label class="field">Model<input id="s-model" value="${esc(s.llm.model)}" placeholder="llama3.1"></label>
      </div>
      <p style="color:var(--faint);font-size:12px;margin-top:10px">100% local & private. Setup: install <a href="https://ollama.com" target="_blank" style="color:var(--accent)">Ollama</a> → <code>ollama pull llama3.1</code> → done. ARIA detects it automatically.</p></div>

      <div class="card"><h3>📮 Brief delivery (email)</h3><div class="form-grid">
        <label class="field">SMTP host<input id="s-smtphost" value="${esc(s.smtp.host)}" placeholder="smtp.gmail.com"></label>
        <label class="field">Port<input id="s-smtpport" value="${s.smtp.port}" placeholder="587"></label>
        <label class="field">User<input id="s-smtpuser" value="${esc(s.smtp.user)}" placeholder="you@gmail.com"></label>
        <label class="field">App password<input id="s-smtppass" type="password" value="${esc(s.smtp.pass)}" placeholder="••••••••"></label>
        <label class="field">Send brief to<input id="s-smtpto" value="${esc(s.smtp.to)}" placeholder="you@gmail.com"></label>
      </div><p style="color:var(--faint);font-size:12px;margin-top:10px">Gmail: enable 2FA → create an App Password → use it above.</p></div>

      <div class="card"><h3>📲 Install · 🔊 Sound · 🔔 Notifications</h3>
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          <button class="btn js-install" data-force="1">📲 Install on this device</button>
          <button class="btn" id="btn-sound-toggle">${Sound.label()}</button>
          <button class="btn" id="btn-test-voice">▶ Test ARIA's voice</button>
        </div>
        <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:10px">
          <button class="btn" id="btn-push">🔔 Enable morning notifications</button>
          <button class="btn ghost" id="btn-push-test">Send test notification</button>
        </div>
        <p style="color:var(--faint);font-size:12px;margin-top:12px">Install puts ARIA on your home screen / desktop like a native app — full screen, offline access to your latest brief, and her voice every morning. Notifications deliver the brief to your lock screen at ${esc(s.wakeTime)} even before you open the app.</p>
      </div>

      <div class="card"><h3>🔌 Connectors</h3>
        ${conns.map(c => { const meta = connMeta[c.id] || ['⚪', c.id, '']; const conf = s.connectors[c.id] || {}; return `
        <div class="connector">
          <div class="conn-icon">${meta[0]}</div>
          <div class="conn-main"><div class="conn-name">${meta[1]}
            ${c.configured ? '<span class="chip green">ready</span>' : '<span class="chip yellow">setup needed</span>'}
            ${c.enabled ? '<span class="chip blue">on</span>' : '<span class="chip">off</span>'}</div>
            <div class="conn-desc">${meta[2]}</div></div>
          ${c.id !== 'demo' ? `<button class="btn small" data-cfg="${c.id}">configure</button>` : ''}
          <label class="switch"><input type="checkbox" data-conn="${c.id}" ${c.enabled ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        ${c.id !== 'demo' ? `<div class="conn-config" id="cfg-${c.id}"><div class="form-grid">${configFields(c.id, conf)}</div></div>` : ''}`; }).join('')}
      </div>
    </div>
    <p style="margin-top:14px;color:var(--faint);font-size:12px">Secrets never leave your machine — stored in <code>data/settings.json</code> on your own disk.</p>`;

  $('#set-save').onclick = async () => {
    await POST('/api/settings', {
      owner: { name: $('#s-name').value, timezone: $('#s-tz').value, location: { lat: +$('#s-lat').value, lon: +$('#s-lon').value, label: $('#s-loc-label').value } },
      wakeTime: $('#s-wake').value,
      llm: { provider: $('#s-provider').value, ollamaUrl: $('#s-ourl').value, model: $('#s-model').value },
      smtp: { host: $('#s-smtphost').value, port: +$('#s-smtpport').value || 587, user: $('#s-smtpuser').value, pass: $('#s-smtppass').value, to: $('#s-smtpto').value }
    });
    for (const c of conns) {
      const enabled = $(`input[data-conn="${c.id}"]`).checked;
      const cfg = configValues(c.id);
      await POST(`/api/connectors/${c.id}`, { enabled, config: cfg });
    }
    toast('Settings saved — schedules re-armed');
    await refreshState(); updateSidebar();
  };
  $$('button[data-cfg]', main).forEach(b => b.onclick = () => $(`#cfg-${b.dataset.cfg}`).classList.toggle('open'));
  $('#btn-sound-toggle').onclick = () => { Sound.toggle(); $('#btn-sound-toggle').textContent = Sound.label(); toast(Sound.label()); };
  $('#btn-test-voice').onclick = () => Sound.morning();
  $('#btn-push').onclick = () => PushClient.subscribe();
  $('#btn-push-test').onclick = () => PushClient.test();
}

function configFields(id, conf) {
  const F = {
    google: [['clientId', 'Client ID'], ['clientSecret', 'Client secret', 'password'], ['refreshToken', 'Refresh token', 'password']],
    microsoft: [['accessToken', 'Graph access token', 'password']],
    slack: [['userToken', 'User token (xoxp-…)', 'password']],
    whatsapp: [['accessToken', 'Cloud API access token', 'password'], ['phoneNumberId', 'Phone number ID']]
  };
  return (F[id] || []).map(([k, label, type]) => `<label class="field">${label}<input data-k="${id}.${k}" type="${type || 'text'}" value="${esc(conf[k] || '')}"></label>`).join('');
}
function configValues(id) {
  const out = {};
  $$(`input[data-k^="${id}."]`).forEach(i => { const k = i.dataset.k.split('.')[1]; if (i.value && !(i.type === 'password' && i.value === '********')) out[k] = i.value; });
  return out;
}

/* ---------------- tasks ---------------- */
function taskRow(t) {
  return `<div class="task ${t.done ? 'done' : ''}" data-task="${esc(t.id)}">
    <input type="checkbox" ${t.done ? 'checked' : ''}>
    <span class="t-title">${esc(t.title)}</span>
    ${t.due ? `<span class="chip yellow">due ${fmtDay(t.due, STATE.timezone)}</span>` : ''}
    <span class="t-src">${esc(t.source)}</span></div>`;
}
function bindTaskToggles(sel) {
  $$(sel).forEach(el => el.querySelectorAll('.task input').forEach(cb => cb.onchange = async () => {
    if (cb.checked) Sound.chirp();
    await POST(`/api/tasks/${cb.closest('.task').dataset.task}/toggle`); route();
  }));
}

/* ---------------- boot ---------------- */
(async function boot() {
  Installer.init();
  Sound.renderChip();
  // Event delegation — covers buttons rendered later (hub, settings) too
  document.addEventListener('click', (e) => {
    const s = e.target.closest('.js-sound');
    if (s) { Sound.toggle(); toast(Sound.label()); if (Sound.on) Sound.pop(); return; }
    const i = e.target.closest('.js-install');
    if (i) Installer.prompt();
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  await refreshState().catch(() => {});
  route();
  setInterval(() => { refreshState().then(updateSidebar).catch(() => {}); }, 60_000);
})();
