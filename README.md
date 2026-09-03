# 🧠 ARIA OS — Your Personal AI Operating System

One dashboard that pulls **everything** from your calendars, email and messages — briefs you every morning at **6:00 AM**, grows a **second brain** from your day job & business, and gives you an **executive assistant** you can ask anything.

> 100% local & private. Runs on your machine. No cloud subscription. AI powered by **Ollama** (free, on-device) with a built-in offline engine as fallback.

---

## 🚀 Hosting: Vercel, Supabase & your phone

**Full deployment guide: [DEPLOY.md](DEPLOY.md)** — covers when you need Supabase, hosting on Vercel for free, using ARIA on your phone, and running it at home with pm2/Tailscale.

## 📲 Install it (phone, tablet, desktop)

ARIA OS is a **PWA** — installable like a native app:

- **Android / Chrome**: open the dashboard → tap the **📲 button** in the sidebar (or Chrome menu → *Install app*).
- **iPhone / iPad**: open in **Safari** → **Share** → **Add to Home Screen**.
- **Desktop**: install icon in the address bar, or the 📲 button.

Installed, it runs full-screen, works **offline** (your latest brief stays readable), and lives on your home screen with the ARIA icon.

## 🔊 Sound & voice

ARIA talks — a real voice greeting plays with your fresh morning brief, priority items announce themselves with a chime + voice, task completions chirp, sends pop. Mute with the **🔊 button** in the sidebar (per-device, remembered).

**Whose voice?** Settings → *Install · Sound · Notifications* → **ARIA's voice** picks a **Male** (default) or **Female** voice, and **▶ Test ARIA's voice** previews it straight away. The choice is stored twice: in `localStorage 'aria.voiceGender'` (instant, per device) and in `settings.voiceGender` (the default a new device adopts). Voice names differ per OS, so ARIA looks for explicitly male voices first (Daniel, Alex, David, Mark, Guy, Fred, Thomas, George, Oliver, Liam, Rishi, Google UK English Male…), keeps the female list for the other setting, and — when a device only offers neutral names — drops the pitch to 0.85 (male) or raises it to 1.05 (female) so ARIA still sounds right.

## 🔔 Morning notifications on your lock screen

Install the app, then **Settings → Enable morning notifications**. At wake time (06:00) the brief is pushed to your device even with the app closed: *"☀️ Morning Brief ready — 3 urgent · 5 events today — tap to read."* Tap it and ARIA opens on the brief.

## ✨ What's inside

| Module | What it does |
|---|---|
| **☀️ Morning Brief** | Compiled fresh every day at your wake time: the one thing that matters, urgent flags, full schedule (day job / business / personal), overnight inbox + messages, top 3 priorities. Delivered to the dashboard **and** your email. |
| **📅 Calendar** | Google Calendar + Outlook + personal — one unified timeline. |
| **📥 Inbox** | Gmail + Outlook unified, priority-scored, auto-tagged *work* vs *business*. |
| **💬 Messages** | Slack + WhatsApp in one feed. |
| **🧠 Second Brain** | An ever-evolving library. It **automatically captures** priority emails, important messages, every brief and a rolling day-log — then indexes everything with **hybrid retrieval** (BM25 + embeddings, 50/50) so you can ask *"what do I know about ___?"* in your own words. Capture anything manually too. |
| **🎯 Action items** | Asks inside emails/messages ("by Friday", "please send", invoices…) become trackable tasks automatically. |
| **🤖 Executive Assistant** | Chat that reasons over your **real** schedule, inbox, messages and brain — and **remembers the conversation**: follow-ups like *"what about tomorrow?"* and *"add another one for Friday"* just work, with people and topics carried across turns, plus a **rolling summary** every 12 turns so memory outlives the 10-turn window. Ask in plain words (*"can you set up a call with the client tomorrow at 11"*) and it **acts**: with a model reachable it tool-calls `create_event`, `add_task`, `complete_task`, `search_calendar`, `search_brain`, `web_search` and `plan_day`, then confirms with the record it really wrote. |
| **🗓️ Autonomous Scheduler** | Say *"plan my day tomorrow"*, *"build a weekly plan"* or *"organize this week"* and ARIA drafts a full calendar around your rhythm — wake-up brief, 2-hour deep-work blocks for high-priority tasks, a meeting window that never double-books, morning & end-of-day inbox triage, business vs day-job blocks, 15-minute buffers — then refines on command (*"move the standup to 10am"*, *"remove the inbox triage"*, *"confirm the plan"*). |
| **🤖 Agency Swarm** | ARIA becomes your **Executive Chief of Staff**: hand her a complex, multi-step mission and she decomposes it and delegates to background specialists — **ResearcherAgent** (second brain + web), **AnalystAgent** (priorities, inbox, financial records), **CopywriterAgent** (emails, proposals, daily summaries) — then signs off one executive report. Every step is replayed live in the UI. |
| **🔌 Connectors** | Opt-in **demo mode** + real adapters: **Gmail/Google Calendar**, **Outlook**, **Slack** (works with a token today), **WhatsApp Business Cloud API** + a universal `/api/ingest` endpoint (iOS Shortcuts, Zapier, n8n…). |

## 🚀 Run it

```bash
npm install
npm start
# → http://localhost:3000
```

First boot starts **empty**. To seed realistic **demo data** (every item clearly marked `DEMO`, purgeable from Settings → Connectors), boot with `ARIA_DEMO=1`:

```bash
ARIA_DEMO=1 npm start
```

You can also talk to ARIA by voice (Assistant → 🎤, or Agency Swarm → 🎤) in browsers with Web Speech API support (Chrome/Edge/Safari; needs HTTPS or localhost), and she reads her replies aloud. The loop is fully two-way and synchronized: what you say lands in the input, is posted to `/api/assistant` (or `/api/agency/run` in the swarm), appended to the transcript, and read back with `speechSynthesis` — the mic is always released while ARIA talks, and the optional wake-word listener (`localStorage.aria.wake = '1'`) re-arms only once she is idle.

**She speaks like a person, not a screen.** Every reply is cleaned before `speechSynthesis`: markdown, code blocks and raw JSON are stripped, raw URLs become *"link"*, emojis become words (📅 → *"calendar"*, ✅ → *"completed"*, 🌐 → *"web result"*), dashes and symbol runs become natural pauses at rate 1.0, offline answers get a conversational lead-in (*"Here's what I found on your calendar…"*), and replies longer than 400 characters are summarised aloud with *"I've shown the full details on your screen."*

**Discretion mode** (Settings, on by default) keeps secrets off the air: passwords, API keys, tokens, M-Pesa PINs, card & account numbers, email addresses and phone numbers are redacted from speech (they stay readable on screen), full inboxes are summarised (*"you have 3 unread — check the app"*), long lists are capped (*"you have 15 open tasks — the top 3 are…"*), and profanity is filtered out of web results and swarm reports.

### 🤖 Agency Swarm — delegate a whole mission

Open **🤖 Agency Swarm** in the sidebar (or the card on the Hub) and hand over something big:

> *"Analyze all supplier notes and draft an executive briefing"*

ARIA (DirectorAgent) splits it into sub-tasks, delegates them, and you watch each agent work in the live execution panel before the final report lands. Tick agents in the roster to force a squad, or leave them unticked and ARIA auto-delegates. Run agents one after another (`sequential`) or in concurrent waves (`parallel`).

```bash
curl -X POST http://localhost:3000/api/agency/run -H 'Content-Type: application/json' \
  -d '{"task":"Analyze all supplier notes and draft an executive briefing","mode":"parallel"}'
# → { "finalOutput": "## 🤖 Agency mission report …",
#     "agentTrace": [ { "agent": "DirectorAgent", "action": "…", "result": "…" }, … ] }
```

| Endpoint | What it does |
|---|---|
| `GET /api/agency/agents` | The swarm roster (id, name, role, skills). |
| `POST /api/agency/plan` | `{ task, agents? }` → the delegation plan, without executing it. |
| `POST /api/agency/run` | `{ task, agents?, mode? }` → `{ finalOutput, agentTrace: [{ agent, action, result }] }`. |
| `GET /api/agency/runs` | Recent missions (also written into the second brain). |

Teach ARIA by talking: **“remember that …”**, **“my name is …”**, **“read this website https://…”** — or paste any URL into **Second Brain → Learn from a website** and she'll read it into her brain.

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
ollama pull qwen2.5:7b        # recommended: best reasoning on ~8 GB of RAM
# ollama pull llama3.1:8b     # solid alternative
ollama pull nomic-embed-text  # optional: turns on SEMANTIC memory (see below)
```

That's it. ARIA detects it automatically (Settings → AI engine). Until then, the built-in **offline engine** answers using intent routing + retrieval over your real data — nothing stops working.

### ☁️ Optional cloud provider (off by default)

Settings → AI engine → *Provider* also accepts **Cloud (OpenAI-compatible)**. Paste a base URL, key and model (`gpt-4o-mini` by default) — or export `OPENAI_API_KEY` — and ARIA prefers the cloud model, falling back to Ollama and then to the offline engine. Any OpenAI-compatible endpoint works (OpenAI, Groq, OpenRouter, a local vLLM). The key is never logged and is never returned by `/api/ai/status`; with no key the provider is never contacted. On small hardware this single switch is the biggest intelligence jump available.

### 🛠️ Tool calling — ARIA can *act*, not only chat

With a model reachable, **every** message the deterministic layer does not recognise is offered to the model with a tool schema. When the model answers `{"tool":"create_event","args":{…}}` ARIA **executes it** through the same internal functions the intent layer uses and replies with the record it actually wrote — so a confirmation is never invented. Tools: `create_event`, `add_task`, `complete_task`, `search_calendar`, `search_brain`, `web_search`, `plan_day`. Unknown tools are never executed and invalid arguments (empty title, unparseable date) write nothing.

### 🧠 Semantic memory

The second brain is a **hybrid retriever**: BM25 lexical scoring blended 50/50 with cosine similarity over embeddings (`server/embeddings.js`). Notes are embedded lazily, once, and cached on the note — but only when an embedding backend is reachable, so without Ollama the brain stays purely lexical and just as fast. That is what makes a paraphrase land: *"who do I know that sells cement?"* now finds the supplier note even when it shares no keywords.

### 🗣️ Say it however you like

The intent layer strips politeness and filler (*"can you"*, *"could you"*, *"please"*, *"hey ARIA"*, *"I want to"*, *"I'd like to"*, *"let's"*) and the scheduling verbs cover *book / set up / arrange / organize / create / make / new / add*, so all of these create a real calendar entry:

```text
can you schedule a meeting with Kamau tomorrow at 2pm
please schedule lunch with Amina on Friday
add a meeting with the supplier at 3pm
set up a call with the client tomorrow at 11
book a meeting with Kamau tomorrow
```

Dates are parsed in **your** timezone (`tomorrow at 2pm`, `on Friday`, `next monday at 10am`, `tonight 8`), and when you name a day but no hour ARIA takes the **first free slot** in your working hours instead of double-booking you (lunch lands at 12:30, not 08:00).

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
  brain.js        second brain: auto-capture, topics, tasks, hybrid search (BM25 + embeddings)
  assistant.js    executive assistant: intent routing · tool calling · planner · discretion
  embeddings.js   embedding adapter (Ollama) + cosine similarity + TF-IDF fallback vector
  agency.js       Agency Swarm orchestrator (sequential / parallel waves, run history)
  agents/         director · researcher · analyst · copywriter (zero-dependency agents)
  llm.js          model adapter: cloud (OpenAI-compatible) → Ollama → offline, tool prompts
  email.js        SMTP brief delivery
  db.js           tiny JSON persistence (data/state.json)
  config.js       settings document: DEFAULTS + normalize() (serverless-safe writes)
  connectors/     demo · google · microsoft · slack · whatsapp
public/           dashboard SPA (no build step)
scripts/          oauth-google helper · test-app.js verification suite (`npm test`)
data/             your everything (gitignored — it IS your brain)
```

---

*Built for personal use. Your data stays on your machine.*
