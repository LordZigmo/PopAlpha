-- 20260301040000_refresh_card_metrics.sql
--
-- refresh_card_metrics()
--
-- Reads from both the new price_snapshots table (JUSTTCG and future providers)
-- and the legacy listing_observations table (EBAY, TCGPLAYER) to produce a
-- unified analytics snapshot in card_metrics.
--
-- Metrics computed per (canonical_slug, printing_id, grade):
--   median_7d            — 50th-pct of prices observed in the last 7 days
--   median_30d           — 50th-pct of prices observed in the last 30 days
--   low_30d / high_30d   — min/max over 30 days
--   trimmed_median_30d   — median of the middle 80% (excluding p10/p90 outliers)
--   volatility_30d       — stddev_pop / median_30d × 100  (coefficient of variation)
--   liquidity_score      — min(active_7d_count × 20, 100)  (0–100)
--   percentile_rank      — percent_rank within the card's set × grade bucket
--
-- Called:
--   • At the end of sync-justtcg-prices (so prices are immediately reflected)
--   • Could also be scheduled independently if other providers are added

create or replace function public.refresh_card_metrics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  -- ── Unified price source ────────────────────────────────────────────────────
  -- price_snapshots holds JUSTTCG (and any future providers).
  -- listing_observations holds legacy EBAY/TCGPLAYER writes (kept until deprecated).
  with all_prices as (
    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from public.price_snapshots
    where observed_at >= now() - interval '30 days'

    union all

    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from public.listing_observations
    where source in ('EBAY', 'TCGPLAYER')
      and observed_at >= now() - interval '30 days'
      and price_value is not null
  ),

  -- ── First pass: base aggregates + bounds for trimmed median ─────────────────
  base_stats as (
    select
      canonical_slug,
      printing_id,
      grade,
      percentile_cont(0.5) within group (order by price_value)
        filter (where observed_at >= now() - interval '7 days')  as median_7d,
      percentile_cont(0.5) within group (order by price_value)   as median_30d,
      min(price_value)                                            as low_30d,
      max(price_value)                                            as high_30d,
      stddev_pop(price_value)                                     as stddev_30d,
      percentile_cont(0.1) within group (order by price_value)   as p10,
      percentile_cont(0.9) within group (order by price_value)   as p90,
      count(*) filter (where observed_at >= now() - interval '7 days') as active_7d_count,
      count(*)                                                    as snapshot_count_30d
    from all_prices
    group by canonical_slug, printing_id, grade
  ),

  -- ── Second pass: trimmed median (median of middle 80%) ─────────────────────
  -- Requires a join-filtered subset, so done separately.
  trimmed as (
    select
      ap.canonical_slug,
      ap.printing_id,
      ap.grade,
      percentile_cont(0.5) within group (order by ap.price_value) as trimmed_median_30d
    from all_prices ap
    join base_stats bs
      on  bs.canonical_slug = ap.canonical_slug
      and bs.printing_id    is not distinct from ap.printing_id
      and bs.grade          = ap.grade
    where ap.price_value between bs.p10 and bs.p90
    group by ap.canonical_slug, ap.printing_id, ap.grade
  ),

  -- ── Derive volatility and liquidity ─────────────────────────────────────────
  computed as (
    select
      bs.canonical_slug,
      bs.printing_id,
      bs.grade,
      bs.median_7d,
      bs.median_30d,
      bs.low_30d,
      bs.high_30d,
      t.trimmed_median_30d,
      case
        when bs.median_30d > 0
        then round((bs.stddev_30d / bs.median_30d * 100)::numeric, 2)
        else null
      end                                                             as volatility_30d,
      least(bs.active_7d_count::numeric * 20, 100)                   as liquidity_score,
      bs.active_7d_count::integer                                     as active_7d_count,
      bs.snapshot_count_30d::integer                                  as snapshot_count_30d
    from base_stats bs
    left join trimmed t
      on  t.canonical_slug = bs.canonical_slug
      and t.printing_id    is not distinct from bs.printing_id
      and t.grade          = bs.grade
  ),

  -- ── Percentile rank within set × grade ──────────────────────────────────────
  ranked as (
    select
      c.*,
      round(
        percent_rank() over (
          partition by cc.set_name, c.grade
          order by c.median_7d nulls last
        ) * 100
      , 2) as percentile_rank
    from computed c
    join public.canonical_cards cc on cc.slug = c.canonical_slug
  )

  -- ── Upsert into card_metrics ─────────────────────────────────────────────────
  insert into public.card_metrics (
    canonical_slug,
    printing_id,
    grade,
    median_7d,
    median_30d,
    low_30d,
    high_30d,
    trimmed_median_30d,
    volatility_30d,
    liquidity_score,
    percentile_rank,
    scarcity_adjusted_value,
    active_listings_7d,
    snapshot_count_30d,
    updated_at
  )
  select
    r.canonical_slug,
    r.printing_id,
    r.grade,
    r.median_7d,
    r.median_30d,
    r.low_30d,
    r.high_30d,
    r.trimmed_median_30d,
    r.volatility_30d,
    r.liquidity_score,
    r.percentile_rank,
    null,                     -- scarcity_adjusted_value: reserved for PSA pop
    r.active_7d_count,
    r.snapshot_count_30d,
    now()
  from ranked r
  on conflict (canonical_slug, printing_id, grade) do update set
    median_7d               = excluded.median_7d,
    median_30d              = excluded.median_30d,
    low_30d                 = excluded.low_30d,
    high_30d                = excluded.high_30d,
    trimmed_median_30d      = excluded.trimmed_median_30d,
    volatility_30d          = excluded.volatility_30d,
    liquidity_score         = excluded.liquidity_score,
    percentile_rank         = excluded.percentile_rank,
    active_listings_7d      = excluded.active_listings_7d,
    snapshot_count_30d      = excluded.snapshot_count_30d,
    updated_at              = excluded.updated_at;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok',   true,
    'rows', affected
  );
end;
$$;
