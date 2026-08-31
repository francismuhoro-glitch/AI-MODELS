# 🧠 ARIA OS — Your Personal AI Operating System

One dashboard that pulls **everything** from your calendars, email and messages — briefs you every morning at **6:00 AM**, grows a **second brain** from your day job & business, and gives you an **executive assistant** you can ask anything.

> 100% local & private. Runs on your machine. No cloud subscription. AI powered by **Ollama** (free, on-device) with a built-in offline engine as fallback.

---

## ✨ What's inside

| Module | What it does |
|---|---|
| **☀️ Morning Brief** | Compiled fresh every day at your wake time: the one thing that matters, urgent flags, full schedule (day job / business / personal), overnight inbox + messages, top 3 priorities. Delivered to the dashboard **and** your email. |
| **📅 Calendar** | Google Calendar + Outlook + personal — one unified timeline. |
| **📥 Inbox** | Gmail + Outlook unified, priority-scored, auto-tagged *work* vs *business*. |
| **💬 Messages** | Slack + WhatsApp in one feed. |
| **🧠 Second Brain** | An ever-evolving library. It **automatically captures** priority emails, important messages, every brief and a rolling day-log — then indexes everything (BM25) so you can ask *"what do I know about ___?"*. Capture anything manually too. |
| **🎯 Action items** | Asks inside emails/messages ("by Friday", "please send", invoices…) become trackable tasks automatically. |
| **🤖 Executive Assistant** | Chat that reasons over your **real** schedule, inbox, messages and brain. Ask for your day, priorities, business snapshot, or to draft email replies. |
| **🔌 Connectors** | Demo mode out of the box + real adapters: **Gmail/Google Calendar**, **Outlook**, **Slack** (works with a token today), **WhatsApp Business Cloud API** + a universal `/api/ingest` endpoint (iOS Shortcuts, Zapier, n8n…). |

## 🚀 Run it

```bash
npm install
npm start
# → http://localhost:3000
```

First boot seeds realistic **demo data** so everything is alive immediately.

## 🔑 Connect your real accounts

Open **Settings → Connectors** in the app:

| Connector | How |
|---|---|
| **Slack** *(easiest)* | api.slack.com/apps → create app → User Token scopes: `channels:read`, `channels:history`, `groups:history`, `im:history` → paste `xoxp-…` token → toggle on. |
| **Google (Gmail + Calendar)** | Google Cloud project → enable Gmail + Calendar APIs → OAuth client (redirect `http://localhost:3111/oauth/google`) → run `npm run oauth:google` → paste the 3 values. |
| **Outlook** | Azure app registration → delegated `Mail.Read`, `Calendars.Read` → device-code access token → paste. |
| **WhatsApp** | Meta developer app → WhatsApp product → access token + phone number ID → paste. Point the inbound webhook at `<your-host>/api/ingest/whatsapp`. |

## 🧬 Upgrade the AI (recommended)

ARIA's brain runs on **Ollama** — free and fully on-device:

```bash
# install from https://ollama.com then:
ollama pull llama3.1
```

That's it. ARIA detects it automatically (Settings → AI Engine). Until then, the built-in **offline engine** answers using intent routing + retrieval over your real data.

## ☀️ Morning brief delivery

- **Dashboard** — always waiting on the Hub when you wake up (auto-generated at your wake time, with catch-up if the machine was asleep).
- **Email** — Settings → *Brief delivery*: add SMTP host (e.g. `smtp.gmail.com`, port 587), your email + an **App Password**, and the destination address.

## 📡 Universal ingest (make it grow from anywhere)

```bash
curl -X POST http://localhost:3000/api/ingest -H 'Content-Type: application/json' \
  -d '{"type":"message","payload":{"source":"sms","channel":"SMS","from":"+254…","text":"M-Pesa: you have received KES 5,000"}}'
```

Types: `email`, `message`, `event`, `note`. Wire it to iOS Shortcuts, Tasker, Zapier, n8n — anything.

## 🗂 Project layout

```
server/
  index.js        API + static hosting (port 3000)
  scheduler.js    cron: brief at wake time, sync every 30 min
  brief.js        morning brief composer (weather via open-meteo, fail-safe)
  brain.js        second brain: auto-capture, topics, tasks, BM25 search
  assistant.js    executive assistant (Ollama or offline engine)
  llm.js          local-LLM adapter
  email.js        SMTP brief delivery
  db.js           tiny JSON persistence (data/state.json)
  connectors/     demo · google · microsoft · slack · whatsapp
public/           dashboard SPA (no build step)
scripts/          oauth-google helper
data/             your everything (gitignored — it IS your brain)
```

---

*Built for personal use. Your data stays on your machine.*
