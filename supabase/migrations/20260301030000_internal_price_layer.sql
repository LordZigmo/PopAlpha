-- 20260301030000_internal_price_layer.sql
--
-- Introduces the provider-agnostic internal price architecture:
--
--   provider_ingests  — raw audit log of every fetch event (per card/variant)
--   price_snapshots   — canonical, normalized price points from any provider
--   card_metrics      — precomputed analytics (what the frontend reads)
--
-- This decouples the frontend from any specific price source. Replacing or
-- adding a provider only requires changes to the ingest layer; card_metrics
-- is what pages query.

-- ── provider_ingests ──────────────────────────────────────────────────────────
-- One row per individual fetch event. Raw payload is kept for debug/replay.

create table if not exists public.provider_ingests (
  id             uuid        primary key default gen_random_uuid(),
  provider       text        not null,                          -- 'JUSTTCG', 'TCGPLAYER', 'EBAY'
  job            text        not null,                          -- cron job name
  set_id         text        null,
  card_id        text        null,
  variant_id     text        null,
  canonical_slug text        null references public.canonical_cards(slug) on delete set null,
  printing_id    uuid        null references public.card_printings(id) on delete set null,
  raw_payload    jsonb       not null default '{}'::jsonb,
  ingested_at    timestamptz not null default now()
);

create index if not exists provider_ingests_provider_idx
  on public.provider_ingests (provider, ingested_at desc);

create index if not exists provider_ingests_slug_idx
  on public.provider_ingests (canonical_slug)
  where canonical_slug is not null;

-- ── price_snapshots ───────────────────────────────────────────────────────────
-- Provider-agnostic normalized price points. This is the canonical internal
-- price store. provider_ref is the provider's own unique ID for this price
-- point and is used for upsert deduplication.

create table if not exists public.price_snapshots (
  id             uuid        primary key default gen_random_uuid(),
  canonical_slug text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id    uuid        null references public.card_printings(id) on delete set null,
  grade          text        not null default 'RAW',
  price_value    numeric     not null,
  currency       text        not null default 'USD',
  provider       text        not null,                          -- 'JUSTTCG', 'TCGPLAYER', 'EBAY'
  provider_ref   text        null,                              -- provider's unique ID (for upsert)
  ingest_id      uuid        null references public.provider_ingests(id) on delete set null,
  observed_at    timestamptz not null default now()
);

-- Dedup: one price point per (provider, provider_ref). NULLs treated as
-- non-equal so rows without provider_ref do not conflict with each other.
create unique index if not exists price_snapshots_provider_ref_uidx
  on public.price_snapshots (provider, provider_ref)
  nulls not distinct
  where provider_ref is not null;

create index if not exists price_snapshots_slug_grade_idx
  on public.price_snapshots (canonical_slug, grade, observed_at desc);

create index if not exists price_snapshots_slug_printing_grade_idx
  on public.price_snapshots (canonical_slug, printing_id, grade, observed_at desc);

create index if not exists price_snapshots_observed_at_idx
  on public.price_snapshots (observed_at desc);

-- ── card_metrics ──────────────────────────────────────────────────────────────
-- Precomputed analytics per (canonical_slug, printing_id, grade).
-- Populated by refresh_card_metrics() (defined in a later migration).
-- This is the table all frontend price queries read from.

create table if not exists public.card_metrics (
  id                      uuid        primary key default gen_random_uuid(),
  canonical_slug          text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id             uuid        null references public.card_printings(id) on delete set null,
  grade                   text        not null default 'RAW',

  -- Price stats
  median_7d               numeric     null,
  median_30d              numeric     null,
  low_30d                 numeric     null,
  high_30d                numeric     null,
  trimmed_median_30d      numeric     null,

  -- Derived signals
  volatility_30d          numeric     null,   -- coefficient of variation × 100
  liquidity_score         numeric     null,   -- 0–100
  percentile_rank         numeric     null,   -- 0–100 within set
  scarcity_adjusted_value numeric     null,   -- reserved for future PSA pop multiplier

  -- Volume
  active_listings_7d      integer     null,
  snapshot_count_30d      integer     null,

  updated_at              timestamptz not null default now()
);

-- Primary upsert target: one row per (canonical_slug, printing_id, grade).
-- NULLs in printing_id are treated as identical (NULLS NOT DISTINCT) so
-- the null-printing "canonical" row has a stable conflict target.
create unique index if not exists card_metrics_slug_printing_grade_uidx
  on public.card_metrics (canonical_slug, printing_id, grade)
  nulls not distinct;

create index if not exists card_metrics_slug_idx
  on public.card_metrics (canonical_slug);

create index if not exists card_metrics_slug_grade_idx
  on public.card_metrics (canonical_slug, grade);
