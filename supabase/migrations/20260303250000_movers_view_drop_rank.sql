-- 20260303250000_movers_view_drop_rank.sql
--
-- Tighten public_variant_movers: remove mover_rank to prevent signal
-- value reconstruction from fine-grained ordering. Expose only the
-- coarse tier bucket + a tier_priority integer for sort ordering.
--
-- tier_priority: 1=hot, 2=warming, 3=cooling, 4=cold
-- Within a tier, order by updated_at DESC (most recently refreshed first).

DROP VIEW IF EXISTS public.public_variant_movers;

CREATE VIEW public.public_variant_movers AS
SELECT
  canonical_slug,
  provider,
  grade,
  printing_id,
  CASE
    WHEN signal_trend >= 70 THEN 'hot'
    WHEN signal_trend >= 40 THEN 'warming'
    WHEN signal_trend >= 20 THEN 'cooling'
    ELSE                         'cold'
  END AS mover_tier,
  CASE
    WHEN signal_trend >= 70 THEN 1
    WHEN signal_trend >= 40 THEN 2
    WHEN signal_trend >= 20 THEN 3
    ELSE                         4
  END AS tier_priority,
  updated_at
FROM public.variant_metrics
WHERE signal_trend IS NOT NULL;

GRANT SELECT ON public.public_variant_movers TO anon, authenticated;
