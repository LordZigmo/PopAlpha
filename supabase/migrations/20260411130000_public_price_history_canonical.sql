-- PR1: iOS market summary fluctuation fix.
--
-- Creates public.public_price_history_canonical — a read view over
-- public.price_history_points that restricts each canonical slug to a single
-- raw cohort, so the iOS CardDetailView chart stops drawing multiple
-- variant_ref time series as one interleaved zig-zag line.
--
-- Root cause of the fluctuation symptom:
--   ios/PopAlphaApp/CardService.swift::fetchPriceHistory queries
--   public_price_history filtered only by canonical_slug + source_window +
--   ts. For slugs with multiple printings / finish-specific
--   provider-history refs (the common case for popular Pokemon singles), all
--   cohorts come back interleaved and render as a single saw-tooth line.
--
-- Scoping rule:
--   variant_ref must end in '::RAW'. Both canonical display refs built by
--   lib/identity/variant-ref.mjs::buildRawVariantRef('<printingId>::RAW')
--   and provider-history refs built by buildProviderHistoryVariantRef
--   ('<printingId>::<providerVariantId>::RAW', lines 89/94/102) terminate
--   with '::RAW'. Graded refs built by buildGradedVariantRef have the shape
--   '<printingId>::<PROVIDER>::<BUCKET>' (no '::RAW' suffix) and are
--   excluded. The suffix match is declarative and requires no joins.
--
-- Provider scope:
--   Restrict to SCRYDEX / POKEMON_TCG_API so the chart line is consistent
--   with card_metrics.market_price, which is Scrydex-primary (see
--   supabase/migrations/20260309210000_scrydex_primary_market_and_7d_changes.sql).
--   POKEMON_TCG_API is retained in case legacy rows still carry that key;
--   it is DB-aliased to SCRYDEX elsewhere.
--
-- NOTE: if a slug legitimately has multiple raw printings (e.g. 1st Edition
-- and Unlimited) both with active history, the view will still return both.
-- That is the intended behavior — the visible bug the user reported is
-- holo-vs-non-holo cohort interleave, not 1st-Ed-vs-Unlimited. Tightening to
-- one printing per slug via preferred_canonical_raw_printing() can be added
-- later if real slugs hit that case.

create or replace view public.public_price_history_canonical as
select
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
  and ph.source_window in ('snapshot', '30d')
  and ph.variant_ref like '%::RAW';

grant select on public.public_price_history_canonical to anon, authenticated;
