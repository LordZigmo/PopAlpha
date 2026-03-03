-- 20260304100000_homepage_movers_priced.sql
--
-- Priced movers view for homepage: joins variant_metrics (signal tiers)
-- with card_metrics (median_7d prices) so we only return movers that have
-- real price data. This prevents the homepage from showing empty movers
-- when the top signal_trend rows happen to lack card_metrics entries.
--
-- Columns:
--   canonical_slug, provider, grade, mover_tier, tier_priority,
--   median_7d, updated_at

DROP VIEW IF EXISTS public.public_variant_movers_priced;

CREATE VIEW public.public_variant_movers_priced AS
SELECT
  vm.canonical_slug,
  vm.provider,
  vm.grade,
  CASE
    WHEN vm.signal_trend >= 70 THEN 'hot'
    WHEN vm.signal_trend >= 40 THEN 'warming'
    WHEN vm.signal_trend >= 20 THEN 'cooling'
    ELSE                            'cold'
  END AS mover_tier,
  CASE
    WHEN vm.signal_trend >= 70 THEN 1
    WHEN vm.signal_trend >= 40 THEN 2
    WHEN vm.signal_trend >= 20 THEN 3
    ELSE                            4
  END AS tier_priority,
  cm.median_7d,
  vm.updated_at
FROM public.variant_metrics vm
JOIN public.card_metrics cm
  ON cm.canonical_slug = vm.canonical_slug
  AND cm.printing_id IS NULL
  AND cm.grade = 'RAW'
  AND cm.median_7d > 0
WHERE vm.signal_trend IS NOT NULL;

GRANT SELECT ON public.public_variant_movers_priced TO anon, authenticated;
