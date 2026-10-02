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

**Which language?** Settings → *Install · Sound · Notifications* → **Language** switches ARIA between **Auto (mirror me)**, **English (en-KE)**, **Swahili (sw-KE)** and **Kikuyu (ki)** — per device instantly, and server-side as the default for a new device. Kikuyu is honest by design: **no browser recognises Kikuyu speech**, so the mic is disabled, badged ⌨️ and says *type your Kikuyu instead*, while typed Kikuyu (and any phrase you add to the dictionary) works. ARIA answers in the language you used and, when unsure in Kikuyu, falls back to Swahili/English — stated in the reply. TTS picks a Swahili voice when the device has one, then Kenyan English, and stays silently text-only if the device has neither (never an uncaught error). Full guide: **[docs/LANGUAGE_VOICE.md](docs/LANGUAGE_VOICE.md)**.

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
| **⏰ Alarms & reminders** | Browser-notification alarms (one-shot, recurring, snooze, cancel) and reminders — never confused with calendar events, and **never claimed as a phone/OS device alarm** (the web platform cannot create one). Times are parsed in **Africa/Nairobi**. Ambiguous times ask before creating. |
| **🗓️ Autonomous Scheduler** | Say *"plan my day tomorrow"*, *"build a weekly plan"* or *"organize this week"* and ARIA drafts a full calendar around your rhythm — wake-up brief, 2-hour deep-work blocks for high-priority tasks, a meeting window that never double-books, morning & end-of-day inbox triage, business vs day-job blocks, 15-minute buffers — each block fitted into the gaps your real calendar actually leaves (a busy morning shrinks a focus block instead of collapsing the plan) — then refines on command (*"move the standup to 10am"*, *"remove the inbox triage"*, *"confirm the plan"*). |
| **🤖 Agency Swarm** | ARIA becomes your **Executive Chief of Staff**: hand her a complex, multi-step mission and she decomposes it and delegates to background specialists — **ResearcherAgent** (second brain + web), **AnalystAgent** (priorities, inbox, financial records), **CopywriterAgent** (emails, proposals, daily summaries) — then signs off one executive report. Every step is replayed live in the UI. |
| **🔌 Connectors** | Opt-in **demo mode** + real adapters: **Gmail/Google Calendar** (OAuth, `gmail.readonly` + `calendar.readonly`), **Outlook** (pasted Graph token), **Slack**, **WhatsApp Business Cloud API** (official only — never WhatsApp Web scraping), **Telegram bot**, **SMTP**, optional **SMS local-device bridge**. Default is **disabled**. Statuses: connected / configured-not-authorized / expired / disabled / unavailable. |

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

With a model reachable, **every** message the deterministic layer does not recognise is offered to the model with a tool schema. When the model answers `{"tool":"create_event","args":{…}}` ARIA **executes it** through the same internal functions the intent layer uses and replies with the record it actually wrote — so a confirmation is never invented. Native OpenAI-compatible tool calling (`role: tool`, bounded iterations, one retry, `parseToolCall` fallback) is preserved; extra hub tools are appended to the same schema. Tools: `create_event`, `add_task`, `complete_task`, `search_calendar`, `search_brain`, `web_search`, `plan_day`, plus `create_alarm` / `list_alarms` / `snooze_alarm` / `cancel_alarm`, `create_reminder` / `list_reminders`, `draft_message` / `send_message` / `list_messages` / `read_message` / `mark_message_read`, `play_music` / `pause_music` / `resume_music` / `skip_track` / `set_volume` / `now_playing`, `search_free_slots`, `start_routine`, `confirm_action`. Unknown tools are never executed. **Sending, deleting, publishing or purchasing never happens from the tool loop** — the owner must confirm in chat or tap Confirm. Drafting is not sending. Group broadcasts stay off unless you opt in.

### 🔐 Permissioned automation hub

Settings → Connectors / Permissions / Alarms / Messaging. Default **deny**. Secrets are never returned by `GET /api/state`, `GET /api/settings` or `GET /api/integrations` (blank password fields keep the previous value). Music is **this browser / a local audio URL only** — ARIA will not pretend to control Spotify or Apple Music. WhatsApp is the official Cloud API only.

| Endpoint | What it does |
|---|---|
| `GET /api/integrations` | Status of every connector (no secrets). |
| `GET /api/oauth/google/start` | Start Google OAuth (readonly Gmail + Calendar). |
| `POST /api/integrations/:id/revoke` | Wipe stored tokens. |
| `GET/POST /api/alarms`, `POST /api/alarms/:id/snooze\|cancel` | Browser-notification alarms. |
| `GET/POST /api/reminders` | Reminders (not calendar events). |
| `POST /api/messages/draft`, `POST /api/messages/send` | Draft ≠ send; send is idempotent and confirm-gated. |
| `GET/POST /api/media/*` | Browser/local playback; `POST /api/media/report` is what confirms it. |
| `GET/POST /api/permissions`, `GET /api/audit`, `POST /api/confirm` | Grants, audit log (no secrets), owner confirmation. |
| `GET /api/phone`, `POST /api/phone/command` | Android bridge status / queue a command (owner side). |
| `GET /api/phone/pending`, `POST /api/phone/ack` | Phone side — bearer-token authed. Poll for commands, ack what really ran. |

### 📱 Android phone bridge — real alarms & music (Tasker / MacroDroid)

Off by default. Turn it on in Settings → **Android phone bridge**, paste a bridge token (stored as a
secret: blanked in every GET, never logged, never given to the model), grant `phone.alarm`,
`phone.media` and/or `phone.app`, then follow **[docs/ANDROID_BRIDGE.md](docs/ANDROID_BRIDGE.md)**
for the copy-paste Tasker profile.

ARIA queues commands (`set_alarm`, `cancel_alarm`, `play`, `pause`, `next`, `previous`, `volume`,
`open_app`) into an outbox. Your phone polls with `Authorization: Bearer <token>`, runs the real
action (Tasker *Set Alarm* / *Media Control* / *Launch App*) and acks. **Until the ack arrives ARIA
only ever says “sent to phone, waiting for confirmation”** — it never claims an alarm rang or a
track played. Commands expire, repeat intents are idempotent, repeat acks are ignored, and a model
can never self-confirm a real device alarm. Every queued command is audited, and an optional
web-push with a fixed title (`ARIA ALARM 06:30`) can wake a Tasker/AutoNotification profile when
polling is not enough.

```bash
npm install
npm test          # verification suite (jsdom + real HTTP, mocked providers only)
npm start         # http://localhost:3000
```

### 🗣️ Swahili, Kikuyu, Sheng — the editable phrase dictionary

A real, editable store (`/api/dictionary`, seeded with 55 phrases) rewrites Swahili/Kikuyu/Sheng
commands into the English the intent layer already understands — **deterministically, with no model
round-trip** — and injects the whole vocabulary into the prompt as grounding for anything longer:

```
"weka kengele kesho asubuhi"  →  set an alarm tomorrow morning   (real alarm created)
"panga siku yangu"            →  plan my day                     (real plan generated)
"nikumbushe kupiga simu kesho"→  reminder created · "sahau" → forget that
"habari ya asubuhi"           →  a Swahili greeting, answered in Swahili
"wĩ mwega" / "ũhoro waku"     →  a Kikuyu greeting, answered in Swahili (stated honestly)
"piga simu kwa Kamau"         →  "I cannot place calls — I can set a reminder or draft a message"
```

Edit or add phrases in **Second Brain → 🗣️ Language & phrases** (add / edit / delete / restore seeds):
`{ phrase, lang, intent, command }`, where `{rest}` keeps whatever followed the phrase. An owner-added
Kikuyu command works on the very next message. Details, capability table and the custom-STT future
path: **[docs/LANGUAGE_VOICE.md](docs/LANGUAGE_VOICE.md)**.

### 🧠 Semantic memory

Two layers, same idea — recall by meaning, not just keywords:

* **Second brain** — a hybrid retriever: BM25 lexical scoring blended 50/50 with cosine similarity over embeddings (`server/embeddings.js`). Notes are embedded lazily, once, and cached on the note, so without a backend it stays purely lexical and just as fast. A paraphrase lands: *"who do I know that sells cement?"* finds the supplier note even when it shares no keywords.
* **Long-term memory about you** (`server/memory.js`) — durable facts, preferences and corrections in a real Postgres table with pgvector (`aria_memory`), or the local JSON store when Supabase is not configured. The incoming message is embedded, the top ~6 memories are injected **before** ARIA (and the Agency Swarm's Director) reasons, and `last_accessed` is bumped for exactly what was used. Embedding chain: **cloud (only with a key) → Ollama → lexical fallback**, all fitted to the same configurable dimension (`settings.llm.embedDim`, default **768**, matching the `vector(768)` column).

```
supabase/migrations/20261002085317_aria_memory.sql   # paste once in the Supabase SQL editor
```

Manage them in **Second Brain → 🧠 Long-term memory** (add / search / edit / delete), or say *"remember that …"* / *"forget that"*. Secrets never reach memory: every write is redacted first. Full guide: **[docs/SEMANTIC_MEMORY.md](docs/SEMANTIC_MEMORY.md)**.

#### 🌱 Durable learning — ARIA learns from the conversation

ARIA **extracts lasting facts, preferences and corrections on its own** and stores them as memories —
no model is ever retrained, learning is retrieval + preference memory (`server/learning.js`):

* **Never blocks a reply.** Extraction is queued out-of-band (the queue is persisted first, drained
  on the next tick and by an hourly sweep at :07 — it survives serverless freezes). Every 12 turns the
  rolling summary window is also offered to the model for JSON extraction; offline, heuristics do it.
* **Filtered hard.** Greetings, thanks, questions and commands are dropped; nothing below
  `MIN_IMPORTANCE 0.55` is stored. PINs, passwords, OTPs, API keys/tokens, card numbers (Luhn-checked)
  and recovery phrases are **rejected before persistence**, never stored in redacted form.
* **Deduped and reconciled.** Near-duplicates merge into one row (Jaccard ≥ 0.86 or cosine ≥ 0.93),
  and a correction **supersedes in place** — *"no, I meant Kamau not Mwangi"* leaves one supplier
  memory, with the old text kept in `metadata.priorContent`. *"My accountant is Otieno"* vs *"my
  lawyer is Otieno"* is explicitly never a conflict.
* **Forgettable.** *"forget that"*, *"forget what you know about my supplier"*, *"forget
  everything"* — the reply states exactly what was removed. The model itself can only *propose* a
  forget; it takes an owner confirmation to delete.

The Second Brain memory card shows the counters (auto-learned · merged · superseded · skipped noise ·
secrets blocked · queue) with a **⚙ Learn now** button. Full guide: **[docs/DURABLE_LEARNING.md](docs/DURABLE_LEARNING.md)**.

| Endpoint | What it does |
|---|---|
| `GET /api/memory`, `GET /api/memory/stats`, `GET /api/memory/search?q=` | List / backend+dimension / hybrid search. |
| `POST /api/memory`, `PATCH\|PUT /api/memory/:id`, `DELETE /api/memory/:id` | Store / edit (re-embeds) / delete — all audited. |
| `POST /api/memory/forget`, `DELETE /api/memory?confirm=true` | *"Forget that"* by id or meaning / clear everything. |
| `GET /api/learning`, `POST /api/learning/run` | Durable-learning counters + policy / drain the learning queue now. |
| `GET /api/language` | Honest voice capability table (mode, STT locales, Kikuyu unavailable, TTS fallback). |
| `GET /api/dictionary`, `POST /api/dictionary`, `PUT\|PATCH\|DELETE /api/dictionary/:id`, `POST /api/dictionary/reset`, `POST /api/dictionary/match` | Phrase dictionary CRUD (Swahili/Kikuyu/Sheng → intents) + seed restore + normalizer debug. |

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

She never double-books a real commitment either: if the hour you asked for is already taken, she books the next free slot and **tells you** which entry owned it (*“Heads up — 14:00 was already taken by …, so I booked 15:00 instead”*). Her own unconfirmed plan blocks are only suggestions, so they step aside for something you actually asked for. `"move it to 14:00"` still forces the exact slot when you insist.

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
  assistant.js    executive assistant: intent routing · tool calling · planner · discretion · hub route
  automation.js   extra tools + deterministic alarms/messages/media/routines
  alarms.js       browser-notification alarms & reminders (never a device alarm)
  phone.js        Android bridge outbox: real device alarms/media via Tasker/MacroDroid + acks
  memory.js       semantic memory: pgvector store (Supabase) / local fallback, hybrid retrieval, forget
  learning.js     durable learning: extraction, noise filter, secret scrubbing, dedupe, conflict supersede, forget
  dictionary.js   language layer: Swahili/Kikuyu/Sheng phrase dictionary, STT/TTS policy, prompt grounding
  permissions.js  default-deny grants, confirmations, audit
  messaging.js    draft ≠ send, idempotent sends, group deny
  media.js        browser / local audio only
  integrations.js OAuth + Telegram/WhatsApp Cloud/SMS-bridge/SMTP
  secrets.js      preserve blank secret saves; redact GET bodies
  embeddings.js   embedding adapter: cloud → Ollama → lexical, dimension-fitted (768 default)
  agency.js       Agency Swarm orchestrator (sequential / parallel waves, run history)
  agents/         director · researcher · analyst · copywriter (zero-dependency agents)
  llm.js          model adapter: cloud (OpenAI-compatible) → Ollama → offline, tool prompts
  email.js        SMTP brief delivery + sendMail
  db.js           tiny JSON persistence (data/state.json)
  config.js       settings document: DEFAULTS + normalize() (serverless-safe writes)
  scheduler.js    cron: brief at wake, sync every 30 min, alarm tick every minute
  connectors/     demo · google · microsoft · slack · whatsapp
public/           dashboard SPA (no build step)
supabase/         migrations you paste into the Supabase SQL editor (idempotent)
scripts/          oauth-google helper · test-app.js verification suite (`npm test`)
data/             your everything (gitignored — it IS your brain)
```

---

*Built for personal use. Your data stays on your machine.*
