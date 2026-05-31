-- Dedupe the canonical price-history chart to one point per day.
--
-- Problem: public_price_history_canonical returned EVERY raw snapshot point
-- with no per-day dedup. For cards with both a live "intraday" capture and a
-- (later) backfilled "noon" point on the same day, the chart plotted both and
-- they disagree, drawing a sawtooth — e.g. ascended-heroes-273-mega-emboar-ex
-- in March (live ~$53 vs backfilled noon $68/$48). Recent ingestion writes one
-- noon point/day, so this is a historical artifact in the 3-month window, but
-- it's systemic (any card with backfill+live overlap).
--
-- Fix: DISTINCT ON (canonical_slug, day) keeping one point per UTC day, picking
-- the point whose created_at is CLOSEST to its ts — i.e. the original same-day
-- capture in preference to a later backfill (tie → latest ts). All filters,
-- columns, and column order are unchanged, so the contract check + the iOS /
-- portfolio consumers (which select ts/price/currency and filter on
-- variant_ref/source_window/currency) are unaffected. Verified: per-card query
-- still pushes the canonical_slug filter into the index scan (~40ms).
--
-- NOTE: this removes the duplicate-per-day sawtooth. It does NOT fix days whose
-- ONLY data is a noisy backfill value (a separate backfill-source data-quality
-- question) — those remain one (possibly spiky) point/day.
--
-- supersedes: 20260524174552_harden_raw_price_history_views.sql
--             (public_price_history_canonical: same columns + filters; adds the
--              per-day DISTINCT ON dedup only.)

create or replace view public.public_price_history_canonical as
select distinct on (ph.canonical_slug, date_trunc('day', ph.ts))
  ph.id,
  ph.canonical_slug,
  ph.variant_ref,
  ph.provider,
  ph.ts,
  ph.price,
  ph.currency,
  ph.source_window,
  ph.created_at
from public.price_history_points ph
where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
  and ph.source_window = 'snapshot'
  and ph.currency = 'USD'
  and ph.price > 0
  and ph.printing_id is not null
  and ph.variant_ref like '%::RAW'
  and ph.variant_ref not ilike '%::GRADED::%'
  and split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and split_part(ph.variant_ref, '::', 1)::uuid = ph.printing_id
  and ph.printing_id = public.preferred_canonical_raw_printing(ph.canonical_slug)
order by
  ph.canonical_slug,
  date_trunc('day', ph.ts),
  abs(extract(epoch from (ph.created_at - ph.ts))) asc,
  ph.ts desc;
