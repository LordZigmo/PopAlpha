-- 20260303114500_refresh_price_changes_no_timeout.sql
--
-- Allow the full catalog backfill to complete without the default statement
-- timeout canceling refresh_price_changes().

CREATE OR REPLACE FUNCTION public.refresh_price_changes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = 0
AS $$
DECLARE
  updated_count int := 0;
  nulled_count  int := 0;
  cutoff_8d     timestamptz := now() - interval '8 days';
  cutoff_24h    timestamptz := now() - interval '24 hours';
  cutoff_7d     timestamptz := now() - interval '7 days';
BEGIN
  WITH recent_points AS (
    SELECT
      canonical_slug,
      variant_ref,
      ts,
      price
    FROM public.price_history_points
    WHERE provider = 'JUSTTCG'
      AND source_window = '30d'
      AND ts >= cutoff_8d
  ),
  variant_stats AS (
    SELECT
      canonical_slug,
      variant_ref,
      count(*) AS point_count,
      max(ts) AS latest_ts
    FROM recent_points
    GROUP BY canonical_slug, variant_ref
  ),
  best_variant AS (
    SELECT DISTINCT ON (canonical_slug)
      canonical_slug,
      variant_ref
    FROM variant_stats
    ORDER BY canonical_slug, point_count DESC, latest_ts DESC NULLS LAST
  ),
  latest_price AS (
    SELECT DISTINCT ON (rp.canonical_slug)
      rp.canonical_slug,
      rp.price AS price_now,
      rp.ts AS latest_ts
    FROM recent_points rp
    JOIN best_variant bv USING (canonical_slug, variant_ref)
    ORDER BY rp.canonical_slug, rp.ts DESC
  ),
  price_at_24h AS (
    SELECT DISTINCT ON (rp.canonical_slug)
      rp.canonical_slug,
      rp.price AS price_24h
    FROM recent_points rp
    JOIN best_variant bv USING (canonical_slug, variant_ref)
    WHERE rp.ts <= cutoff_24h
    ORDER BY rp.canonical_slug, rp.ts DESC
  ),
  price_at_7d AS (
    SELECT DISTINCT ON (rp.canonical_slug)
      rp.canonical_slug,
      rp.price AS price_7d
    FROM recent_points rp
    JOIN best_variant bv USING (canonical_slug, variant_ref)
    WHERE rp.ts <= cutoff_7d
    ORDER BY rp.canonical_slug, rp.ts DESC
  ),
  changes AS (
    SELECT
      lp.canonical_slug,
      lp.price_now,
      lp.latest_ts,
      CASE
        WHEN p24.price_24h IS NOT NULL AND p24.price_24h > 0 AND lp.latest_ts > cutoff_24h
        THEN ((lp.price_now - p24.price_24h) / p24.price_24h) * 100
        ELSE NULL
      END AS change_pct_24h,
      CASE
        WHEN p7.price_7d IS NOT NULL AND p7.price_7d > 0 AND lp.latest_ts > cutoff_7d
        THEN ((lp.price_now - p7.price_7d) / p7.price_7d) * 100
        ELSE NULL
      END AS change_pct_7d
    FROM latest_price lp
    LEFT JOIN price_at_24h p24 USING (canonical_slug)
    LEFT JOIN price_at_7d p7 USING (canonical_slug)
  ),
  do_update AS (
    UPDATE public.card_metrics cm
    SET
      market_price = c.price_now,
      market_price_as_of = c.latest_ts,
      change_pct_24h = c.change_pct_24h,
      change_pct_7d = c.change_pct_7d
    FROM changes c
    WHERE cm.canonical_slug = c.canonical_slug
      AND cm.printing_id IS NULL
      AND cm.grade = 'RAW'
      AND (
        cm.market_price IS DISTINCT FROM c.price_now
        OR cm.market_price_as_of IS DISTINCT FROM c.latest_ts
        OR cm.change_pct_24h IS DISTINCT FROM c.change_pct_24h
        OR cm.change_pct_7d IS DISTINCT FROM c.change_pct_7d
      )
    RETURNING cm.id
  )
  SELECT count(*) INTO updated_count FROM do_update;

  WITH slugs_with_history AS (
    SELECT DISTINCT canonical_slug
    FROM public.price_history_points
    WHERE provider = 'JUSTTCG'
      AND source_window = '30d'
      AND ts >= cutoff_8d
  ),
  do_null AS (
    UPDATE public.card_metrics cm
    SET
      market_price = NULL,
      market_price_as_of = NULL,
      change_pct_24h = NULL,
      change_pct_7d = NULL
    WHERE cm.printing_id IS NULL
      AND cm.grade = 'RAW'
      AND (
        cm.market_price IS NOT NULL
        OR cm.market_price_as_of IS NOT NULL
        OR cm.change_pct_24h IS NOT NULL
        OR cm.change_pct_7d IS NOT NULL
      )
      AND cm.canonical_slug NOT IN (SELECT canonical_slug FROM slugs_with_history)
    RETURNING cm.id
  )
  SELECT count(*) INTO nulled_count FROM do_null;

  RETURN jsonb_build_object(
    'updated', updated_count,
    'nulled', nulled_count
  );
END;
$$;
