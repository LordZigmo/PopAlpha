-- 20260303240000_public_variant_movers.sql
--
-- Public movers view: exposes ranking + tier labels derived from signal columns,
-- but NOT the raw signal values. This lets listMovers() sort and filter via
-- dbPublic() without needing service-role access.
--
-- Columns exposed:
--   canonical_slug, provider, grade, printing_id
--   mover_rank  — dense_rank() ordered by signal_trend DESC NULLS LAST
--   mover_tier  — 'hot' | 'warming' | 'cooling' | 'cold' (bucketed from signal_trend)
--   updated_at
--
-- Raw signal_trend / signal_breakout / signal_value are NOT exposed.

CREATE OR REPLACE VIEW public.public_variant_movers AS
SELECT
  canonical_slug,
  provider,
  grade,
  printing_id,
  dense_rank() OVER (
    ORDER BY signal_trend DESC NULLS LAST
  )::integer AS mover_rank,
  CASE
    WHEN signal_trend IS NULL            THEN NULL
    WHEN signal_trend >= 70              THEN 'hot'
    WHEN signal_trend >= 40              THEN 'warming'
    WHEN signal_trend >= 20              THEN 'cooling'
    ELSE                                      'cold'
  END AS mover_tier,
  updated_at
FROM public.variant_metrics
WHERE signal_trend IS NOT NULL;

GRANT SELECT ON public.public_variant_movers TO anon, authenticated;
