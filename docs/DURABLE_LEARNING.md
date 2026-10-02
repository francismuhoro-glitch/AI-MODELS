# 🧠 Durable learning

ARIA doesn't retrain a model. "Learning" here means **retrieval + preference memory**: the things
you tell it in conversation become rows in long-term memory (`aria_memory` in Supabase, or the local
JSON store), and those rows are pulled back in **before** it reasons. This document covers the
learning engine in `server/learning.js` — what gets learned, what is deliberately thrown away, and
how a correction replaces an old fact instead of sitting next to it contradicting it.

```
your turn ──▶ reply goes out immediately (extraction is NEVER awaited)
                 │
                 └─▶ queue persisted in db.meta.learningQueue
                        │
                        └─▶ setImmediate ─▶ scrub ─▶ filter ─▶ dedupe ─▶ conflict ─▶ memory
                                                          (hourly sweep at :07 catches leftovers)
```

---

## The five hard rules

| # | Rule | Where it lives |
|---|---|---|
| 1 | **No synchronous turn latency** — a reply is never blocked by learning | `scheduleExtraction()` persists the turn, then `setImmediate(processQueue)`; `respond()` does not await it |
| 2 | **Conflict resolution, not contradiction** — a correction supersedes the old row in place | `conflictDecision()` + supersede path in `storeCandidate()` |
| 3 | **Strict noise filter** — filler, questions and commands are never learned | `isFiller()` + `hasSignal()` + `MIN_IMPORTANCE` |
| 4 | **Hard secret/PII scrubbing BEFORE persistence** — rejected outright, not redacted-after | `containsHardSecret()` → candidate is dropped and counted as `rejected` |
| 5 | **Training-free** — no model is ever fine-tuned; the model can also never delete memory by itself | `stats().training` + the `forget_memory` confirmation gate |

---

## 1. Extraction (two paths, neither blocks a turn)

### a. High-signal turns (free, offline)

Every turn that finishes `respond()` is offered to `scheduleExtraction({ message, reply, source })`.
`hasSignal()` is a cheap regex gate, so ordinary chatter never even enters the queue. When it looks
promising, the queue entry is written to `db.meta.learningQueue` **first** — if the process dies
mid-extraction (serverless freeze, restart), the next turn or the hourly sweep drains it.

`EXTRACTORS` (regex/heuristic, ids in order): `correction`, `correction-2`, `remember`, `identity`,
`call-me`, `preference`, `preference-neg`, `routine`, `life`, `contact`.

| You say | Candidate (kind) |
|---|---|
| "No, I meant my supplier is Kamau not Mwangi" | correction |
| "Remember that Kamau is my cement supplier" | fact |
| "I prefer invoices sent on Fridays" | preference |
| "I hate early meetings" | preference (negated) |
| "I always start with the Nairobi depot" | routine/fact |
| "My accountant is Otieno" | fact |
| "Call me Boss" | fact |

Greetings, thanks, "ok cool", questions, and commands (`schedule …`, `play …`) extract **nothing** —
they are not statements about you.

### b. The rolling cadence (model-assisted, every 12 turns)

`rollConversationSummary()` (assistant.js, `SUMMARY_EVERY = 12`) also hands the conversation window
to `scheduleSummaryExtraction({ turns, windowText, chatId })`. With a model configured it uses
`EXTRACT_PROMPT` and a tolerant `parseCandidatesJson()` (handles code fences, prose wrappers,
truncated JSON); when ARIA is offline the heuristics are the fallback, so the feature works with no
keys and no Ollama.

Only the interesting window-level items make it: candidates are capped at `MAX_CANDIDATES = 6`,
content is capped at `MAX_CONTENT = 400` characters — **full message bodies are never stored**, only
the extracted sentence.

---

## 2. Noise filtering

Every candidate must clear **`MIN_IMPORTANCE = 0.55`**. Filler never does. Importance rises for
preferences, corrections, identity/contact statements and explicit "remember that …" instructions,
and falls for anything short, vague or question-shaped. A candidate below the bar is counted as
`skipped` with reason `below-threshold` and nothing is written.

`isFiller()` also hard-drops greetings, acknowledgements, thanks, pure emoji and anything under a
few meaningful words.

---

## 3. Secret and PII scrubbing (before persistence)

Candidates are checked with `containsHardSecret()`. A hit means the candidate is **rejected** — the
secret is never written, not even in a redacted form (a redacted card number is still a fact about
your card). Rules:

| Rule | Catches |
|---|---|
| `pin` / `mpesa-pin` | "my PIN is 4821", M-Pesa PIN phrasing |
| `otp` | one-time codes |
| `password` | passwords and passphrases |
| `api-key` / `key-shape` | `sk_…`, `pk_…`, `ghp_…`, `AIza…`, `xox…` token shapes |
| `private-key` / `seed-phrase` | PEM blocks, recovery phrases |
| `cvv` | card security codes |
| `card` | 13–19 digit numbers that pass the **Luhn** checksum |

Everything that survives is *also* passed through `secrets.redactText()` as a second net, so even a
missed pattern cannot leak into a stored memory. `GET /api/learning` reports the `rejected` counter
and the policy list — you can watch it work.

---

## 4. Dedupe and merge

Two statements that mean the same thing become **one row**:

| Signal | Threshold | Action |
|---|---|---|
| identical `dedupeKey` (fingerprint) | exact | merge |
| Jaccard similarity of token bigrams | `≥ MERGE_JACCARD = 0.86` | merge |
| cosine similarity vs the stored embedding | `≥ MERGE_SIM = 0.93` | merge |

Merging keeps the longest content, takes the higher importance, bumps `metadata.mergeCount` and
preserves the earliest provenance — the row count never inflates. Say the same thing five times and
you get one memory that says "you've told me this five times", not five memories.

---

## 5. Conflict resolution

The interesting case is a statement that is *about the same thing* but *says something different* —
"my supplier is Mwangi" → "no, I meant Kamau". ARIA must not keep both.

`conflictDecision(existing, new, { kind, semantic })` is a **pure function** (unit-testable, no I/O):

1. **Subject guard** — `conflictingSubjects()` drops generic verbs (`prefer`, `like`, `hate`, …) from
   the subject words; a subject clash (accountant vs lawyer) means *no conflict, ever*, no matter how
   similar the sentences look.
2. **Same-subject update** — needs ≥ 2 shared anchors plus (surface ≥ 0.25 **or** semantic ≥ 0.5), or
   one shared anchor with surface ≥ 0.3.
3. **Explicit correction** — "no, I meant …" / "actually …" / "correction:" — ≥ 1 anchor plus
   (surface ≥ 0.2 or semantic ≥ 0.52).
4. **Polarity flip** — opposite sentiment verbs (*like* vs *hate*, *prefer* vs *avoid*) on a shared
   anchor: conflict.

When it fires, the old row is **superseded in place**: same id, new content, old text preserved in
`metadata.priorContent` with `supersededAt` / `supersededReason`, and the row's kind becomes
`correction`. One supplier memory survives — the corrected one — and you can still see what changed.

Regression cases that must **never** conflict: *"my accountant is Otieno"* vs *"my lawyer is
Otieno"* (0.75 cosine — similarity alone would be wrong), *"I like Kamau"* vs *"I like Mwangi"*, and
any two unrelated statements. All of them are pinned in `scripts/test-app.js` section `[3o]`.

---

## 6. Forgetting ("forget that")

Typed **or spoken** (the transcript goes through the same assistant path):

| You say | What happens |
|---|---|
| "forget that" / "forget it" / "delete that memory" | deletes the newest auto-learned memory |
| "forget what you know about my supplier" | deletes memories whose content contains **every** content word of the topic — never neighbours |
| "forget everything" | clears long-term memory, reports the count |
| "what do you remember about X?" | deterministic recall reply from memory (no model needed) |

The reply always states **exactly** what was removed, or says plainly that nothing matched. Topic
forgets deliberately do not fall back to raw embedding similarity: "supplier" scores high against
every supplier sentence, so similarity alone would over-delete.

**The model cannot delete memory.** If the LLM calls the `forget_memory` tool, `automation.js`
creates an owner confirmation and returns a reply saying *nothing was deleted*. Only the owner
confirming (`confirmPending`) actually runs `learning.forget`, and every path is audited
(`integration: 'memory'`, action `forget` / `forget-all`).

---

## 7. API and UI

| Endpoint | What it does |
|---|---|
| `GET /api/learning` | counters (`saved`, `merged`, `superseded`, `skipped`, `rejected`, `pending`), policy, recent log (max 60), `training: 'none …'` |
| `POST /api/learning/run` | drains the queue on demand (the ⚙ Learn now button) |
| `GET /api/memory/stats` | now embeds the same `learning` block |

**Second Brain → 🧠 Long-term memory** shows the learning strip (auto-learned / merged / superseded /
skipped noise / secrets blocked / queue) plus **⚙ Learn now**. You can edit or delete any row there,
including ones ARIA learned on its own.

The hourly scheduler job (`7 * * * *`) drains `learning.flush()` and then `memory.expireStale()`, so
low-importance items age out and queued turns survive serverless freezes.

---

## 8. Honest limits

* Extraction quality depends on the model only for the **rolling cadence** path; the heuristic path
  is regex-based and conservative by design — it will occasionally miss a fact rather than save
  junk. You can always teach one explicitly ("remember that …") from chat or the Brain UI.
* Conflict detection is deterministic and explainable, not an LLM judgement call. It favours missing
  a conflict over deleting a valid memory; when it supersedes, the previous text is kept in
  `metadata.priorContent`.
* Nothing is ever sent to a training pipeline, and nothing learns from other users — memory is your
  own table (RLS on, no public policies).
* "Forget that" removes the row from long-term memory. If the same sentence was also captured as a
  note in the Second Brain, the reply says so — deleting the note is a separate action.

Tests: `scripts/test-app.js` → `[3o]` covers extraction, the importance bar, secret rejection,
dedupe/merge, every conflict case (including the never-conflict pairs), non-blocking behaviour with a
deliberately slow store, queue persistence across a simulated crash, the API endpoints, and every
"forget that" flow including the model-cannot-self-confirm gate.
