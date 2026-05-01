-- 20260423010000_phase2d_canonical_view_v2.sql
--
-- Phase 2d: rewrite public_price_history_canonical to filter on the
-- backfilled printing_id column. Drops the variant_ref-parsing picker.
--
-- Context:
--   Phase 2a added (printing_id, finish, provider_variant_token) columns
--   on price_history_points and a partial index. Phase 2b inserted
--   missing (slug, finish) card_printings rows. Phase 2c backfilled the
--   new columns for every raw row (canonical + provider-history shapes).
--
-- After 2c, canonical view resolution reduces to:
--   1. Compute the preferred printing_id for the slug via
--      preferred_canonical_raw_printing(slug) — already exists; picks
--      by (language, edition, stamp, finish priority).
--   2. Filter rows where printing_id equals that value.
--
-- This is an index lookup on idx_price_history_points_slug_printing_ts
-- (the partial index from 2a) — far cheaper than the Phase 1 picker's
-- per-slug aggregate on variant_ref.
--
-- Phase 1 function preferred_canonical_raw_variant_ref is kept as a
-- fallback hook that isn't called by this view. Dropped entirely in 2e
-- once we're satisfied the new path is stable.
--
-- Rollback: re-apply 20260422200000_canonical_pin_provider_variant.sql.

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
  and ph.printing_id is not null
  and ph.printing_id = public.preferred_canonical_raw_printing(ph.canonical_slug);

grant select on public.public_price_history_canonical to anon, authenticated;

-- Companion view: all raw history scoped to an explicit printing. Used
-- by callers that already know the printing (iOS finish pill, web
-- market-summary card's per-variant panel) so they can filter cleanly by
-- printing_id without reinventing the provider/source_window/raw/graded
-- predicates every time.
create or replace view public.public_price_history_by_printing as
select
  ph.id,
  ph.canonical_slug,
  ph.printing_id,
  ph.finish,
  ph.provider_variant_token,
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
  and ph.printing_id is not null;

grant select on public.public_price_history_by_printing to anon, authenticated;
