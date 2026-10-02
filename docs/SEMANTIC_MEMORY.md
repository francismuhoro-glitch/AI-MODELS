# 🧠 Semantic memory (pgvector)

ARIA remembers **durable facts, preferences and corrections** about you — and recalls them by
*meaning*, not just keywords. This is what makes “who supplies my cement?” find *“Mwangi Hardware
sells cement”* even when the words differ.

Everything here degrades gracefully: with **no Supabase, no keys and no Ollama** the memory lives
in the local JSON store and retrieval falls back to the lexical half. Nothing breaks.

---

## 1. The table (approved schema, one paste)

Run this **once** in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run):

```
supabase/migrations/20261002085317_aria_memory.sql
```

It is **idempotent** (`create … if not exists`) and safe to run again. It creates:

| Object | Purpose |
| --- | --- |
| `public.aria_memory` | One row per memory: `id`, `content`, `embedding vector(768)`, `source`, `kind`, `importance`, `dedupe_key`, `metadata`, `created_at`, `last_accessed`, `updated_at`, `expires_at` |
| `aria_memory_embedding_hnsw_idx` | HNSW cosine index (no training needed, fast while rows are added) |
| `aria_memory_created_at_idx`, `aria_memory_importance_idx` | Recent / most-important lookups |
| `aria_memory_dedupe_key_idx` | Unique (when set) → makes “merge duplicates” race-safe |
| `match_aria_memories(query_embedding, match_threshold, match_count)` | Cosine similarity search (expired rows excluded) |
| `touch_aria_memories(memory_ids)` | Bumps `last_accessed` for what was just retrieved |

**RLS is enabled with no policies** — your server’s `service_role` key keeps full access, an anon
key can read nothing. Default deny, at the database edge too.

`aria_docs` (the JSON document table) is **not touched**.

### Verify it

The SQL file ends with a read-only sanity query — it prints one row:

```
status            | rows | indexes | functions
aria_memory ready |    0 |       4 |         2
```

You can also check from the app: **Settings → 🧠 Semantic memory** shows `supabase` or `local`,
and `GET /api/memory/stats` returns `{ backend, dim, count, kinds, … }`.

---

## 2. The embedding dimension — the one thing that must agree

The vector column, the SQL function and the app must all use the **same** number.

| Place | Value |
| --- | --- |
| `aria_memory.embedding` | `vector(768)` |
| `match_aria_memories(query_embedding vector(768), …)` | `768` |
| `settings.llm.embedDim` (or env `ARIA_EMBED_DIM`) | `768` (default) |

**Why 768?** It works for both ends of the provider chain:

* **Ollama** `nomic-embed-text` → 768 natively (runs locally, free, private).
* **OpenAI** `text-embedding-3-small` → asked for exactly 768 via the API’s `dimensions`
  parameter (Matryoshka training makes the leading dimensions meaningful).

If a provider returns a different size, ARIA fits it to 768 automatically:
longer vectors are **truncated** to the leading dims, shorter ones are **zero-padded**, and both
are re-normalised (unit length), so cosine geometry stays valid. (This is deliberate, tested
behaviour — see `fitDimension` in `server/embeddings.js`.)

### Changing the dimension later

Only do this if you switch embedding models and must keep every bit of precision:

```sql
alter table public.aria_memory alter column embedding type vector(1536);
drop index if exists public.aria_memory_embedding_hnsw_idx;
create index aria_memory_embedding_hnsw_idx on public.aria_memory
  using hnsw (embedding vector_cosine_ops);
-- then re-run sections 5 and 6 of the migration with vector(1536),
-- and set ARIA_EMBED_DIM=1536 (or settings.llm.embedDim = 1536).
```

Existing rows would need re-embedding; the app re-embeds each memory the next time you edit it.

---

## 3. Provider chain (`server/embeddings.js`)

```
1. cloud   — any OpenAI-compatible /embeddings endpoint
             settings.llm.openai.apiKey  (or env OPENAI_API_KEY)
             model: settings.llm.openai.embedModel, default text-embedding-3-small
             OFF unless a key exists. Failures cool down for 2 minutes so a wrong key
             cannot slow down every chat turn. The key is never logged or returned.
2. ollama  — settings.llm.ollamaUrl, model settings.llm.embedModel (default nomic-embed-text)
3. lexical — deterministic hashing vector (fallbackVector) at the same dimension
```

`GET /api/ai/status` now includes an `embedding` block:

```json
"embedding": { "dim": 768, "cloudConfigured": false, "ollamaReachable": false,
               "cloudCoolingDown": false, "activeBackend": "lexical" }
```

No key, no secret, ever.

---

## 4. Retrieval — hybrid, before anything reasons

`server/memory.js` is the whole memory layer:

```
incoming message
   → embed it (provider chain, 768 dims)
   → candidates:  match_aria_memories() RPC (Supabase)  +  the most recent rows
   → rank:        0.5 · BM25(normalised)  +  0.5 · cosine similarity
                  (+ a small importance tie-break)
   → top 6 are injected into the prompt as a MEMORY block
   → last_accessed is bumped for exactly those rows
```

* The **assistant** injects the block before the tool pass, before the main chat call and before
  the offline engine (which will answer from memory if nothing else fits).
* The **Agency Swarm** retrieves memories for the mission and adds a
  **“Standing context (from memory)”** section to the Director’s report, so your preferences
  shape the mission instead of generic advice.
* The **second brain** keeps its own BM25 + embedding hybrid (`server/brain.js`) — unchanged.
  Memory is the same idea, but *about you*, and it lives in Postgres.

With no embedding backend at all, the RPC is skipped entirely (never called with a null vector)
and ranking is lexical-only — the honest degradation, and it is covered by tests.

---

## 5. Managing memories

**Second Brain → 🧠 Long-term memory** (or Settings → 🧠 Semantic memory for the status):

* **Add** a fact / preference / correction by hand.
* **Search** by meaning.
* **Edit** (re-embeds automatically when the text changes).
* **Delete** one, or *Delete all*.
* From chat: *“remember that Kamau is my cement supplier”* → stored. *“forget that”* → removes the
  matching memories.

API:

| Endpoint | What it does |
| --- | --- |
| `GET /api/memory` | List (array, `?limit=&offset=`) |
| `GET /api/memory/stats` | Backend, dimension, counts, kinds |
| `GET /api/memory/search?q=` | Hybrid search |
| `POST /api/memory` | Store `{ content, kind?, importance?, source? }` |
| `PATCH/PUT /api/memory/:id` | Edit (re-embeds if the content changed) |
| `DELETE /api/memory/:id` | Delete one |
| `POST /api/memory/forget` | `{ ids: [...] }` or `{ query: "..." }` |
| `DELETE /api/memory?confirm=true` | Delete everything |

Every store/forget is written to the audit log (`GET /api/audit`).

---

## 6. What is deliberately NOT stored

* **Secrets** — content passes through `secrets.redactText()` before it is written, so anything
  looking like an API key, token or password becomes `[redacted]`.
* **PINs, card numbers, full message bodies** — the extraction policy (Phase 3) only ever writes
  short statements, never a raw message; the redactor is the backstop.
* Content is capped at 1000 characters and whitespace-normalised.

`expires_at` is honoured everywhere: expired rows are excluded from retrieval and pruned by the
hourly sweep (`memory.expireStale()`, wired into the scheduler).

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Settings shows `local` although Supabase env vars are set | The `aria_memory` table does not exist yet, or the key is wrong. Run the migration; check `GET /api/memory/stats`. |
| Writes fail but reads work | The RPC/table exists but RLS blocks the key you configured — use the **service_role** key (`SUPABASE_SERVICE_KEY`), not the anon key. |
| `activeBackend: "lexical"` | No cloud key and no reachable Ollama. Pull an embedding model: `ollama pull nomic-embed-text`. |
| Dimension error from Postgres (`expected 768 dimensions`) | `settings.llm.embedDim` / `ARIA_EMBED_DIM` disagrees with the column. Make them match (§2). |
| Memories are missing after a deploy | Only possible with the **local** fallback (serverless `/tmp` is ephemeral). Configure Supabase — that is exactly why the table exists. |
| Retrieval feels keyword-only | Expected offline. Add a cloud key or a local embedding model; the hybrid blend starts using the semantic half immediately. |
