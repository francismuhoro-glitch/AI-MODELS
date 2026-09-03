## What this fixes

Three things the owner reported, plus the intelligence upgrade that came with them.

| # | Report | Root cause | Fix |
|---|---|---|---|
| 1 | *"The assistant can't create events when I ask it"* | `routeIntent()`'s schedule regex only matched messages that **started** with `schedule\|add event\|create meeting\|meeting with\|calendar`, and with Ollama running those messages fell through to `llmChat()`, which could only **talk** — the model could claim it scheduled something while writing nothing | Filler-stripping + widened verbs (deterministic, works with **no** LLM), **and** an LLM tool-calling pass that executes for real |
| 2 | *"I want a male voice"* | `Speech.pickVoice()` hard-coded a female name preference (`/aria\|female\|samantha\|zira\|…/i`), so ARIA always sounded female | Gender preference, **default male**, in `localStorage 'aria.voiceGender'` + `settings.voiceGender`; picker rewritten; pitch fallback for neutral voice names; Settings select + preview |
| 3 | *"It's not intelligent enough"* | the model could never act; `server/embeddings.js` was dead code; no cloud option; context pack missed tomorrow/turns; memory died after 10 turns | tool loop, semantic memory, optional cloud provider, richer context + better default model, rolling conversation summary |

`npm test` → **329 passed, 0 failed** (the 180 pre-existing checks are untouched and still pass, plus 149 new ones). No new runtime dependencies. Serverless-safe writes. Offline mode still answers.

---

## Issue 1 — natural phrasing creates real events

All five reported phrasings now write to `db.events` and confirm with the record they wrote:

```text
can you schedule a meeting with Kamau tomorrow at 2pm   → Meeting with Kamau      tomorrow 14:00
please schedule lunch with Amina on Friday              → Lunch with Amina        Friday 12:30
add a meeting with the supplier at 3pm                  → Meeting with the supplier today 15:00
set up a call with the client tomorrow at 11            → Call with the client    tomorrow 11:00
book a meeting with Kamau tomorrow                      → Meeting with Kamau      tomorrow (first free slot)
```

- `stripFiller()` removes *"can you", "could you", "please", "hey ARIA", "I want to", "I'd like to", "let's", "go ahead and", "kindly"…* before the intent regexes; verbs now cover `book|set up|arrange|organize|create|make|new|add` — guarded so *"create a summary of my inbox"* and *"add a task to call the supplier"* are **not** hijacked into the calendar.
- `parseRelativeDateTime()` is now **timezone-aware** (owner tz, not server tz): `tomorrow at 2pm`, `on Friday`, `next monday at 10am`, `tonight 8`, `noon`, `this afternoon`. `dayKey(start,'Africa/Nairobi')` is now stable no matter where the process runs — previously "2pm" meant 2pm *server* time and displayed as 17:00 in Nairobi.
- Mutations live in shared internals (`createEvent`, `addTask`, `completeTaskByQuery`, `calendarSummary`, `brainSummary`) used by **both** the regex layer and tool calls; each one calls `brain.buildIndex()` + `dbm.saveNow()`.
- Never double-books: an un-timed request takes the first free slot in the owner's working hours (lunch → 12:30, not 08:00); an explicit time is honoured exactly and a clash is reported **in words**.
- `complete_task` no longer fuzzy-matches on any single generic word (it used to be able to complete the wrong task via the word "task").

## Issue 2 — a male voice, by default

- `pickVoice(list, gender)` is now a **pure, exported** function (`window.AriaSpeech.pickVoice`, `window.AriaPickVoice`): English voices first → explicitly male names (`daniel, alex, fred, thomas, george, oliver, liam, noah, aaron, arthur, rishi, eddy, rocko, grandpa, reed, junior, ralph, microsoft david|mark|guy, google uk english male, google us english`) → any voice that isn't clearly the other gender → best English voice.
- Neutral names get the gender from pitch instead: `u.pitch = 0.85` (male) / `1.05` (female) in `speak()`.
- Stored twice: `localStorage 'aria.voiceGender'` (instant, per device, written on boot) and `settings.voiceGender` (server default a new device adopts via `/api/state`).
- Settings → **Install · Sound · Notifications** gains an *"ARIA's voice"* select (Male/Female) with **▶ Test ARIA's voice** beside it, previewing through the real `Speech.speak()` pipeline. Changing it re-picks immediately (`_voice = null` → `prime()`), **Save all** persists it.

## Issue 3 — the intelligence upgrade

1. **Tool-calling loop.** `llmChat(system, user, history, tools)` appends a strict *reply with ONLY* `{"tool":…,"args":{…}}` instruction. `respond()` routes **every** non-regex message through the tool pass before web search / plain chat. Tools: `create_event`, `add_task`, `complete_task`, `search_calendar`, `search_brain`, `web_search`, `plan_day`. `parseToolCall()` handles bare JSON, ` ```json ` fences, JSON buried in prose, and light repairs (trailing commas, smart quotes). **Unknown tools are never executed**; invalid args (empty title, unparseable date) write nothing — so a confirmation is always the record that was really written.
2. **Semantic memory.** `server/embeddings.js` was dead code — `brain.js` now blends `0.5·BM25(norm) + 0.5·cosine`, embedding each note once (lazy, cached as `note.embedding`, **only** when a backend is reachable, capped + rate-limited) and caching the query vector. The TF-IDF `fallbackVector` path remains the graceful degradation. Offline, ranking is exactly the old BM25 order and `score` keeps its meaning for existing thresholds (`blended` is the new rank key). `GET /api/search` and `ResearcherAgent` use it too.
3. **Cloud provider (optional, OFF by default).** `settings.llm.openai = { baseUrl, apiKey, model }` (+ `OPENAI_API_KEY` env). Order: cloud → Ollama → offline. The key is never logged and never returned by `llmStatus()` / `GET /api/ai/status`. Settings exposes the provider plus base URL / key / model.
4. **Better default model + context.** `DEFAULTS.llm.recommendedModel = 'qwen2.5:7b'` (with `llama3.1:8b` documented) surfaced in the Settings hint; `contextPack()` now carries the rolling summary, today+upcoming, **TOMORROW**, the **last 3 turns**, priority emails/messages, open tasks and brain hits — in owner-local time.
5. **Conversation summary.** Every 12 turns the conversation is compressed into `db.meta.conversation.summary` (LLM-written, heuristic fallback listing people / topics / decisions), secret-redacted and prepended to the context pack, so memory survives past the 10-turn window.

## Tests added (`scripts/test-app.js`)

| Section | Covers |
|---|---|
| `[3g]` | the five natural phrasings → `/Scheduled/i` + a real event with the right title **and** day key; no double-booking; recall on *"what is my schedule tomorrow"*; `stripFiller` / `matchScheduleRequest` / `parseRelativeDateTime` units |
| `[3h]` | tool schema; parser (valid JSON, ` ```json ` fences, prose-wrapped, repaired, invalid → `null`); `create_event`/`add_task`/`complete_task`/`search_calendar`/`search_brain` execute for real; unknown tools and bad args write nothing |
| `[3i]` | blend ordering with `fallbackVector` (exact-term > paraphrase > unrelated), `blendScore` weights, cosine guards, offline stays lexical, `primeEmbeddings` no-ops without a backend |
| `[3j]` | `DEFAULTS`/`normalize()` (voiceGender, llm.openai, recommended model, clamping), provider resolution incl. **openai key unset → falls through to offline without throwing**, key never leaked by `llmStatus()`/`/api/ai/status` |
| `[3k]` | `contextPack` contains *Upcoming* + *Tomorrow* + last 3 turns and survives a null LLM; rolling summary written at 12 turns, persisted, prepended, secrets redacted |
| `[5c]` | jsdom: `localStorage 'aria.voiceGender'` defaults to `male`; `pickVoice` → David for male / Zira for female; neutral-name + empty-list paths; the Settings select renders, switches instantly and persists via **Save all** |
| `[6]` | end-to-end tool loop against a **mock model server**: the schema/context/history really reach the model, a tool call is executed and confirmed with the real record, and a prose-only answer writes nothing |

### One pre-existing flake fixed at the source

`view "assistant" renders` asserted that the rendered view contains no `⚠️`. `"move the standup to 10am"` legitimately warns about overlapping a seed event — but only during certain hours of the day (the seed event sits at *now + 1h*), so `npm test` failed on `main` when run in the morning and passed at night. Assistant replies now report clashes in words instead of with a warning glyph, so the transcript can never look like a render failure. **No existing check was modified.**

## Acceptance criteria

1. ✅ `npm test` → `329 passed, 0 failed`, including all 180 pre-existing checks (verified twice, and again in a fresh clone of `main` with the patch applied).
2. ✅ All five phrasings create real events in `db.events` and confirm in the reply; *"what is my schedule tomorrow"* then lists them.
3. ✅ `pickVoice` honours gender; default male; Settings exposes and persists it.
4. ✅ Tool calls execute for real (events/tasks actually written); no invented confirmations.
5. ✅ No new runtime dependencies; writes tolerate a read-only filesystem (verified with a `chmod 0555` data dir — assistant, tools and settings all keep working in memory); offline mode still answers.
6. ✅ Committed on `arena/01a065c8-ai-models`, PR opened to `main`, and `ARIA-intelligence-upgrade.patch` applies cleanly onto `main` (`git apply --check` clean; full suite green afterwards).

---

*PR title:* `feat(aria): natural-language scheduling, LLM tool calling, male voice, semantic memory`
*Base:* `main`  ·  *Head:* `arena/01a065c8-ai-models`
*Patch:* `ARIA-intelligence-upgrade.patch` (`git apply ARIA-intelligence-upgrade.patch` on a clean `main`)
