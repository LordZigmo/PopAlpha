-- supersedes: 20260423055611_phase2d_canonical_view_v2.sql
--
-- Phase C-3 (2026-05-16): tighten public_price_history_by_printing to
-- source_window = 'snapshot' only. The chart consumer at
-- components/market-summary-card.tsx reads from this view to render
-- the headline price history line. Today the view also passes
-- source_window = '30d', which historically meant "scrydex 30d trend
-- anchor" — synthetic backfill points computed against scrydex's
-- market series.
--
-- After Phase A (PR #87) switched the headline price from scrydex's
-- `market` to its `low` (TCGplayer Market Price alignment), keeping
-- the old market-basis '30d' anchors in the same series as low-basis
-- snapshots creates chart discontinuity — the anchor for "yesterday"
-- can show ¥7,500 while today's snapshot reads ¥4,300, producing a
-- phantom -43% drop. Phase A patched around this by disabling anchor
-- writes; Phase C-3 re-enables them with explicit basis tagging
-- (source_window = 'market_anchor_30d' / 'market_anchor_180d') so the
-- chart can filter them out cleanly while metrics still consume them
-- via observation.history_points_30d (a separate JSONB column).
--
-- Effects:
--   * Chart no longer surfaces leftover pre-Phase-A '30d' anchor
--     rows (still in price_history_points until 90-day retention
--     prunes them; just not user-visible).
--   * New '30d'/'180d' anchors written by extractTrendAnchorPoints
--     are tagged 'market_anchor_*' and skip the view filter, so the
--     chart stays low-basis end-to-end.
--   * Metrics path is unaffected (reads from the observation
--     history_points_30d column, not the view).
--
-- Other consumers of price_history_points (variant-metrics writers,
-- the scrydex-price-history backfill) read the table directly and
-- aren't affected by view filter changes.

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
  and ph.source_window = 'snapshot'
  and ph.printing_id is not null;

grant select on public.public_price_history_by_printing to anon, authenticated;
