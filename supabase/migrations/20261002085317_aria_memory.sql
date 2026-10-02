-- ═══════════════════════════════════════════════════════════════════════════════════════
-- ARIA OS — Phase 2: semantic memory (pgvector)
-- 2026-10-02 · approved schema · IDEMPOTENT: safe to run again, changes nothing if present.
--
-- What this creates
--   1. public.aria_memory            — one row per durable memory (fact / preference / correction / summary)
--   2. four indexes                  — HNSW vector index + created_at + importance + unique dedupe key
--   3. public.match_aria_memories()  — cosine similarity search used by server/memory.js
--   4. public.touch_aria_memories()  — bump last_accessed after a retrieval (one round-trip)
--
-- What this does NOT touch
--   • aria_docs (id text, data jsonb, updated_at timestamptz) is untouched — ARIA's JSON documents
--     keep living there. Memory rows go in their own table, as approved.
--   • No rows are inserted. Nothing is dropped. No data is modified.
--
-- Dimension: 768. It is locked into three places that MUST agree:
--   • aria_memory.embedding            vector(768)
--   • match_aria_memories(query_embedding vector(768), …)
--   • settings.llm.embedDim / ARIA_EMBED_DIM in the app (default 768, used by server/embeddings.js)
-- 768 works for local Ollama (nomic-embed-text = 768) AND for OpenAI's text-embedding-3-small,
-- which can be asked for exactly 768 dimensions. To change it later, see the note at the bottom.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- 1 ▸ pgvector -------------------------------------------------------------------------
create extension if not exists vector;

-- 2 ▸ the memory table -----------------------------------------------------------------
create table if not exists public.aria_memory (
  id            text        primary key,
  content       text        not null,
  embedding     vector(768) not null,
  source        text        not null default 'chat',
  kind          text        not null default 'fact',
  importance    real        not null default 0.5,
  dedupe_key    text,
  metadata      jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_accessed timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz
);

comment on table  public.aria_memory is 'ARIA semantic memory: short durable facts/preferences/corrections. Never stores secrets, PINs, tokens, card numbers or full message bodies.';
comment on column public.aria_memory.content    is 'The memory text (short, redacted, no full message bodies).';
comment on column public.aria_memory.embedding  is 'Embedding vector, dimension 768 — must match settings.llm.embedDim and match_aria_memories().';
comment on column public.aria_memory.source     is 'Where it came from: chat | summary | user | import.';
comment on column public.aria_memory.kind       is 'fact | preference | correction | summary (corrections and preferences outrank plain facts).';
comment on column public.aria_memory.importance is '0..1 ranking weight; low + stale entries are expired by the app.';
comment on column public.aria_memory.dedupe_key is 'Normalised fingerprint used to merge near-duplicates (unique when present).';
comment on column public.aria_memory.metadata   is 'Small extras (topics, chatId, model). No secrets.';
comment on column public.aria_memory.expires_at is 'NULL = keep forever. Otherwise the app prunes it after this moment.';

-- 3 ▸ indexes --------------------------------------------------------------------------
-- HNSW (not ivfflat): no training step, builds correctly on an empty table, and stays fast
-- while rows are inserted continuously — which is exactly how memory grows.
create index if not exists aria_memory_embedding_hnsw_idx
  on public.aria_memory using hnsw (embedding vector_cosine_ops);

create index if not exists aria_memory_created_at_idx
  on public.aria_memory (created_at desc);

create index if not exists aria_memory_importance_idx
  on public.aria_memory (importance desc);

-- One row per dedupe fingerprint → makes "merge near-duplicates" race-safe.
create unique index if not exists aria_memory_dedupe_key_idx
  on public.aria_memory (dedupe_key)
  where dedupe_key is not null;

-- 4 ▸ row level security (default deny) ------------------------------------------------
-- RLS on with NO policies: the server's service key (BYPASSRLS) keeps working, while an
-- anon/public API key can read or write NOTHING. Same default-deny rule as the app.
alter table public.aria_memory enable row level security;

-- 5 ▸ similarity search ----------------------------------------------------------------
-- security invoker: the caller's rights apply; the app calls this with the service key.
-- Pass query_embedding either as a JSON array or as the pgvector text form '[0.1,0.2,…]'.
create or replace function public.match_aria_memories(
  query_embedding vector(768),
  match_threshold float default 0.2,
  match_count     int   default 8
)
returns table (
  id            text,
  content       text,
  source        text,
  kind          text,
  importance    real,
  created_at    timestamptz,
  last_accessed timestamptz,
  similarity    float
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    m.id,
    m.content,
    m.source,
    m.kind,
    m.importance,
    m.created_at,
    m.last_accessed,
    (1 - (m.embedding <=> query_embedding))::float as similarity
  from public.aria_memory m
  where (m.expires_at is null or m.expires_at > now())
    and (1 - (m.embedding <=> query_embedding)) >= match_threshold
  order by m.embedding <=> query_embedding
  limit greatest(1, least(coalesce(match_count, 8), 50));
$$;

comment on function public.match_aria_memories(vector, float, int) is 'Cosine similarity search over aria_memory (expired rows excluded). Called by server/memory.js via PostgREST RPC.';

-- 6 ▸ retrieval bookkeeping ------------------------------------------------------------
-- One round-trip to mark the memories that were just used (the app calls this after retrieval).
create or replace function public.touch_aria_memories(memory_ids text[])
returns integer
language sql
security invoker
set search_path = public
as $$
  with bumped as (
    update public.aria_memory m
       set last_accessed = now()
     where m.id = any(memory_ids)
    returning 1
  )
  select count(*)::integer from bumped;
$$;

comment on function public.touch_aria_memories(text[]) is 'Bump last_accessed for the given memory ids. Returns the number of rows touched.';

-- 7 ▸ sanity check (read-only — shows one row when everything is in place) --------------
select
  'aria_memory ready' as status,
  (select count(*) from public.aria_memory) as rows,
  (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'aria_memory') as indexes,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('match_aria_memories', 'touch_aria_memories')) as functions;

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Changing the embedding size later (only if you switch models)
--   alter table public.aria_memory alter column embedding type vector(1536);
--   drop index if exists public.aria_memory_embedding_hnsw_idx;
--   create index aria_memory_embedding_hnsw_idx on public.aria_memory
--     using hnsw (embedding vector_cosine_ops);
--   -- then re-run sections 5 and 6 with vector(1536) and set ARIA_EMBED_DIM=1536.
-- Existing rows would need re-embedding (the app re-embeds on the next write/edit).
-- ═══════════════════════════════════════════════════════════════════════════════════════
