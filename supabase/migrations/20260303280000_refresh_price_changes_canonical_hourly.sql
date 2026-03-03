-- 20260303280000_refresh_price_changes_canonical_hourly.sql
--
-- Improve canonical card price deltas by:
--   1) building a canonical hourly price series per card across all variants
--   2) sourcing market_price from that canonical series
--   3) relaxing the 24H anchor to the closest point in the 24-36h window
--   4) relaxing the 7D anchor to the closest point in the 6-8 day window

CREATE OR REPLACE FUNCTION public.refresh_price_changes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = 0
SET lock_timeout = 0
AS $$
DECLARE
  updated_count int := 0;
  nulled_count  int := 0;
  cutoff_8d     timestamptz := now() - interval '8 days';
  cutoff_7d     timestamptz := now() - interval '7 days';
  cutoff_6d     timestamptz := now() - interval '6 days';
  cutoff_36h    timestamptz := now() - interval '36 hours';
  cutoff_24h    timestamptz := now() - interval '24 hours';
BEGIN
  WITH recent_points AS (
    SELECT
      canonical_slug,
      ts,
      price
    FROM public.price_history_points
    WHERE provider = 'JUSTTCG'
      AND source_window = '30d'
      AND ts >= cutoff_8d
  ),
  canonical_hourly AS (
    SELECT
      rp.canonical_slug,
      date_trunc('hour', rp.ts) AS bucket_ts,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY rp.price) AS canonical_price,
      max(rp.ts) AS source_ts,
      count(*)::integer AS points_in_bucket
    FROM recent_points rp
    GROUP BY rp.canonical_slug, date_trunc('hour', rp.ts)
  ),
  latest_price AS (
    SELECT DISTINCT ON (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price AS price_now,
      ch.bucket_ts AS latest_ts
    FROM canonical_hourly ch
    ORDER BY ch.canonical_slug, ch.bucket_ts DESC, ch.points_in_bucket DESC
  ),
  price_near_24h AS (
    SELECT DISTINCT ON (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price AS price_24h,
      ch.bucket_ts AS price_24h_ts
    FROM canonical_hourly ch
    WHERE ch.bucket_ts BETWEEN cutoff_36h AND cutoff_24h
    ORDER BY
      ch.canonical_slug,
      abs(extract(epoch FROM (ch.bucket_ts - cutoff_24h))) ASC,
      ch.bucket_ts DESC,
      ch.points_in_bucket DESC
  ),
  price_near_7d AS (
    SELECT DISTINCT ON (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price AS price_7d,
      ch.bucket_ts AS price_7d_ts
    FROM canonical_hourly ch
    WHERE ch.bucket_ts BETWEEN cutoff_8d AND cutoff_6d
    ORDER BY
      ch.canonical_slug,
      abs(extract(epoch FROM (ch.bucket_ts - cutoff_7d))) ASC,
      ch.bucket_ts DESC,
      ch.points_in_bucket DESC
  ),
  changes AS (
    SELECT
      lp.canonical_slug,
      lp.price_now,
      lp.latest_ts,
      CASE
        WHEN p24.price_24h IS NOT NULL
          AND p24.price_24h > 0
          AND lp.latest_ts > cutoff_24h
          AND p24.price_24h_ts < lp.latest_ts
        THEN ((lp.price_now - p24.price_24h) / p24.price_24h) * 100
        ELSE NULL
      END AS change_pct_24h,
      CASE
        WHEN p7.price_7d IS NOT NULL
          AND p7.price_7d > 0
          AND p7.price_7d_ts < lp.latest_ts
        THEN ((lp.price_now - p7.price_7d) / p7.price_7d) * 100
        ELSE NULL
      END AS change_pct_7d
    FROM latest_price lp
    LEFT JOIN price_near_24h p24 USING (canonical_slug)
    LEFT JOIN price_near_7d p7 USING (canonical_slug)
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
