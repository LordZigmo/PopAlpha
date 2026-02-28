-- 20260301130000_refresh_derived_signals.sql
--
-- refresh_derived_signals()
--
-- Computes PopAlpha branded signals from provider_* columns already stored
-- in card_metrics and writes them back in-place.
--
-- Only updates the LATEST row per canonical_slug (by updated_at) so stale
-- rows from previous ingest runs are never over-written with bad data.
--
-- Signals:
--
--   signal_trend_strength
--     = provider_trend_slope_7d / NULLIF(provider_cov_price_30d, 0)
--     Stability-adjusted momentum. Null when either input is null.
--
--   signal_breakout
--     = provider_trend_slope_7d
--       × LN(1 + COALESCE(provider_price_changes_count_30d, 0))
--       × (1 - COALESCE(provider_price_relative_to_30d_range, 0.5))
--     Rewards accelerating momentum with activity and room to run.
--     Null when trend_slope_7d is null.
--
--   signal_value_zone
--     = (1 - provider_price_relative_to_30d_range) × 100
--     100 = at 30-day low, 0 = at 30-day high. Null when range is null.
--
-- Called by:
--   • app/api/cron/refresh-derived-signals/route.ts  (nightly after sync-justtcg)
--   • Can also be triggered manually via RPC

create or replace function public.refresh_derived_signals()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  -- Identify the latest row per canonical_slug.
  -- DISTINCT ON (canonical_slug) ORDER BY canonical_slug, updated_at DESC
  -- gives us exactly one row per slug — the most recently refreshed one.
  with latest as (
    select distinct on (canonical_slug)
      id,
      provider_trend_slope_7d,
      provider_cov_price_30d,
      provider_price_relative_to_30d_range,
      provider_price_changes_count_30d
    from public.card_metrics
    where provider_as_of_ts is not null   -- only rows that have provider data
    order by canonical_slug, updated_at desc
  )
  update public.card_metrics cm
  set
    signal_trend_strength = case
      when l.provider_trend_slope_7d is not null
       and l.provider_cov_price_30d  is not null
      then round(
        (l.provider_trend_slope_7d / nullif(l.provider_cov_price_30d, 0))::numeric,
        4
      )
      else null
    end,

    signal_breakout = case
      when l.provider_trend_slope_7d is not null
      then round(
        (
          l.provider_trend_slope_7d
          * ln(1 + coalesce(l.provider_price_changes_count_30d, 0)::numeric)
          * (1 - coalesce(l.provider_price_relative_to_30d_range, 0.5))
        )::numeric,
        4
      )
      else null
    end,

    signal_value_zone = case
      when l.provider_price_relative_to_30d_range is not null
      then round(
        ((1 - l.provider_price_relative_to_30d_range) * 100)::numeric,
        2
      )
      else null
    end,

    signals_as_of_ts = now()

  from latest l
  where cm.id = l.id;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok',   true,
    'rows', affected
  );
end;
$$;
