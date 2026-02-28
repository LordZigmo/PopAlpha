-- 20260301080000_price_history_points.sql
--
-- price_history_points: granular provider time-series price data.
--
-- Distinct from price_history (daily median snapshots — kept unchanged).
-- This table stores individual price observations from provider history
-- arrays (e.g. JustTCG priceHistory30d: [{p, t}, ...]).
--
-- variant_ref is a stable, provider-agnostic string identifying the
-- finish+condition+grade combination, e.g. "holo:nm:raw".
-- This avoids the NULL printing_id headache and works even when a
-- card_printing row doesn't exist yet.
--
-- Unique key: (canonical_slug, variant_ref, provider, ts)
-- ON CONFLICT DO NOTHING makes daily re-runs fully idempotent.

create table if not exists public.price_history_points (
  id             uuid        primary key default gen_random_uuid(),
  canonical_slug text        not null references public.canonical_cards(slug) on delete cascade,
  variant_ref    text        not null,   -- e.g. "HOLO:Near Mint:RAW"
  provider       text        not null,
  ts             timestamptz not null,
  price          numeric     not null,
  currency       text        not null default 'USD',
  source_window  text        not null default '30d',
  created_at     timestamptz not null default now()
);

create unique index if not exists price_history_points_dedup_idx
  on public.price_history_points (canonical_slug, variant_ref, provider, ts);

create index if not exists price_history_points_slug_ts_idx
  on public.price_history_points (canonical_slug, ts desc);

create index if not exists price_history_points_provider_ts_idx
  on public.price_history_points (provider, ts desc);

create index if not exists price_history_points_slug_variant_ts_idx
  on public.price_history_points (canonical_slug, variant_ref, ts desc);

-- ── Extend provider_raw_payloads ──────────────────────────────────────────────
-- request_hash: stable hash of (provider + endpoint + params) for dedup/debug
-- canonical_slug: FK when payload is tied to a specific card
-- variant_ref:    provider variant ID or our stable ref string
-- as_of_ts:       when the data was fetched (aliased from fetched_at for clarity)

alter table public.provider_raw_payloads
  add column if not exists request_hash   text        null,
  add column if not exists canonical_slug text        null,
  add column if not exists variant_ref    text        null;

create index if not exists provider_raw_payloads_hash_idx
  on public.provider_raw_payloads (request_hash)
  where request_hash is not null;
