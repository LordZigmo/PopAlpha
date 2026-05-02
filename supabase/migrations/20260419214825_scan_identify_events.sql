-- 20260419214757_scan_identify_events.sql
--
-- Append-only telemetry for /api/scan/identify. One row per
-- identify request so we can:
--   (a) observe call volume / Replicate credit burn rate
--   (b) build the fine-tuning corpus — (image_hash, top_match,
--       similarity, confidence) pairs are the raw material for a
--       Phase 4 model swap
--   (c) diagnose variant confusion — rank_2_* columns surface the
--       near-miss so we can see when the embedder can't tell
--       e.g. Charizard ex from Charizard V
--
-- Trust model: write via dbAdmin() from app/api/scan/identify/route.ts
-- only. RLS enabled but no policies = only service role can read/write.
-- No user is ever authorized to SELECT their own scan history via
-- public API — that's a privacy decision we haven't made yet.
--
-- We deliberately do NOT store the image bytes. Only a sha256 of the
-- payload, for dedup / diagnostic ("scanned the same card 40 times")
-- lookups. If we later want to retrain on captured frames, we'll need
-- a separate consent-gated pipeline.

create table if not exists public.scan_identify_events (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),

  -- Request fingerprint
  image_hash                text not null,
  image_bytes_size          integer not null,
  language_filter           text not null check (language_filter in ('EN', 'JP')),

  -- Response
  confidence                text not null check (confidence in ('high', 'medium', 'low', 'error')),
  top_match_slug            text null,
  top_similarity            double precision null,
  top_gap_to_rank_2         double precision null,
  rank_2_slug               text null,
  rank_2_similarity         double precision null,

  -- Operational
  model_version             text not null,
  duration_ms               integer not null,
  error                     text null,

  -- Actor (best-effort; whichever of these the request carried)
  actor_key                 text null,
  clerk_user_id             text null,
  client_platform           text null
);

-- Indexes for the queries operators will actually run. created_at
-- DESC powers the "show me the last N scans" feed; top_match_slug
-- is the join key against canonical_cards for per-card diagnostics;
-- confidence powers the "what fraction are high vs medium?" funnel.
create index if not exists scan_identify_events_created_at_idx
  on public.scan_identify_events (created_at desc);

create index if not exists scan_identify_events_top_match_slug_idx
  on public.scan_identify_events (top_match_slug)
  where top_match_slug is not null;

create index if not exists scan_identify_events_confidence_idx
  on public.scan_identify_events (confidence);

create index if not exists scan_identify_events_image_hash_idx
  on public.scan_identify_events (image_hash);

-- Lock it down. Service role bypasses RLS; enabling with no policies
-- means anon / authenticated clients cannot read or write even if
-- something accidentally grants them SELECT.
alter table public.scan_identify_events enable row level security;
