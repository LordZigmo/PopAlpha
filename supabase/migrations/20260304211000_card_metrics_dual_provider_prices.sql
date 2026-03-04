-- 20260304211000_card_metrics_dual_provider_prices.sql
--
-- Metrics-layer provider comparison:
--   - keep provider prices separate (JUSTTCG vs POKEMON_TCG_API)
--   - compute market_price as average of both when both exist
--   - fallback market_price to whichever provider exists
--   - keep change percentages in refresh_price_changes() without overwriting market_price

alter table public.card_metrics
  add column if not exists justtcg_price numeric null,
  add column if not exists pokemontcg_price numeric null,
  add column if not exists provider_compare_as_of timestamptz null;

create or replace function public.refresh_card_metrics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
  removed integer := 0;
begin
  with all_prices_raw as (
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
  all_prices as (
    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from all_prices_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      price_value,
      observed_at
    from all_prices_raw
    where printing_id is not null
  ),
  provider_latest_raw as (
    select distinct on (ps.canonical_slug, ps.printing_id, ps.grade, ps.provider)
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.provider,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.provider in ('JUSTTCG', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '30 days'
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.provider,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider,
      price_value,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider,
      price_value,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  provider_compare as (
    select
      canonical_slug,
      printing_id,
      grade,
      max(case when provider = 'JUSTTCG' then price_value end) as justtcg_price,
      max(case when provider = 'POKEMON_TCG_API' then price_value end) as pokemontcg_price,
      max(case when provider = 'JUSTTCG' then observed_at end) as justtcg_as_of,
      max(case when provider = 'POKEMON_TCG_API' then observed_at end) as pokemontcg_as_of
    from provider_latest
    group by canonical_slug, printing_id, grade
  ),
  base_stats as (
    select
      canonical_slug,
      printing_id,
      grade,
      percentile_cont(0.5) within group (order by price_value)
        filter (where observed_at >= now() - interval '7 days') as median_7d,
      percentile_cont(0.5) within group (order by price_value) as median_30d,
      min(price_value) as low_30d,
      max(price_value) as high_30d,
      stddev_pop(price_value) as stddev_30d,
      percentile_cont(0.1) within group (order by price_value) as p10,
      percentile_cont(0.9) within group (order by price_value) as p90,
      count(*) filter (where observed_at >= now() - interval '7 days') as snapshot_active_7d_count,
      count(*) as snapshot_count_30d
    from all_prices
    group by canonical_slug, printing_id, grade
  ),
  trimmed as (
    select
      ap.canonical_slug,
      ap.printing_id,
      ap.grade,
      percentile_cont(0.5) within group (order by ap.price_value) as trimmed_median_30d
    from all_prices ap
    join base_stats bs
      on bs.canonical_slug = ap.canonical_slug
     and bs.printing_id is not distinct from ap.printing_id
     and bs.grade = ap.grade
    where ap.price_value between bs.p10 and bs.p90
    group by ap.canonical_slug, ap.printing_id, ap.grade
  ),
  history_counts_raw as (
    select
      ph.canonical_slug,
      vm.printing_id,
      vm.grade,
      count(*) filter (where ph.ts >= now() - interval '7 days') as history_7d_count,
      count(*) as history_count_30d
    from public.price_history_points ph
    join public.variant_metrics vm
      on vm.canonical_slug = ph.canonical_slug
     and vm.variant_ref = ph.variant_ref
     and vm.provider = ph.provider
    where ph.ts >= now() - interval '30 days'
      and ph.source_window in ('30d', 'snapshot')
    group by ph.canonical_slug, vm.printing_id, vm.grade
  ),
  history_counts as (
    select
      canonical_slug,
      printing_id,
      grade,
      sum(history_7d_count)::integer as history_7d_count,
      sum(history_count_30d)::integer as history_count_30d
    from (
      select
        canonical_slug,
        printing_id,
        grade,
        history_7d_count,
        history_count_30d
      from history_counts_raw

      union all

      select
        canonical_slug,
        null::uuid as printing_id,
        grade,
        history_7d_count,
        history_count_30d
      from history_counts_raw
      where printing_id is not null
    ) expanded_history
    group by canonical_slug, printing_id, grade
  ),
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
      end as volatility_30d,
      least(
        greatest(
          coalesce(hc.history_7d_count, 0),
          bs.snapshot_active_7d_count
        )::numeric * 20,
        100
      ) as liquidity_score,
      greatest(
        coalesce(hc.history_7d_count, 0),
        bs.snapshot_active_7d_count
      )::integer as active_7d_count,
      greatest(
        coalesce(hc.history_count_30d, 0),
        bs.snapshot_count_30d
      )::integer as snapshot_count_30d,
      pc.justtcg_price,
      pc.pokemontcg_price,
      case
        when pc.justtcg_price is not null and pc.pokemontcg_price is not null
          then round(((pc.justtcg_price + pc.pokemontcg_price) / 2.0)::numeric, 4)
        else coalesce(pc.justtcg_price, pc.pokemontcg_price)
      end as market_price,
      greatest(pc.justtcg_as_of, pc.pokemontcg_as_of) as market_price_as_of,
      greatest(pc.justtcg_as_of, pc.pokemontcg_as_of) as provider_compare_as_of
    from base_stats bs
    left join trimmed t
      on t.canonical_slug = bs.canonical_slug
     and t.printing_id is not distinct from bs.printing_id
     and t.grade = bs.grade
    left join history_counts hc
      on hc.canonical_slug = bs.canonical_slug
     and hc.printing_id is not distinct from bs.printing_id
     and hc.grade = bs.grade
    left join provider_compare pc
      on pc.canonical_slug = bs.canonical_slug
     and pc.printing_id is not distinct from bs.printing_id
     and pc.grade = bs.grade
  ),
  ranked as (
    select
      c.*,
      round((
        percent_rank() over (
          partition by
            cc.set_name,
            c.grade,
            case when c.printing_id is null then 'CANONICAL' else 'PRINTING' end
          order by c.median_7d nulls last
        ) * 100
      )::numeric, 2) as percentile_rank
    from computed c
    join public.canonical_cards cc on cc.slug = c.canonical_slug
  )
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
    justtcg_price,
    pokemontcg_price,
    market_price,
    market_price_as_of,
    provider_compare_as_of,
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
    null,
    r.active_7d_count,
    r.snapshot_count_30d,
    r.justtcg_price,
    r.pokemontcg_price,
    r.market_price,
    r.market_price_as_of,
    r.provider_compare_as_of,
    now()
  from ranked r
  on conflict (canonical_slug, printing_id, grade) do update set
    median_7d = excluded.median_7d,
    median_30d = excluded.median_30d,
    low_30d = excluded.low_30d,
    high_30d = excluded.high_30d,
    trimmed_median_30d = excluded.trimmed_median_30d,
    volatility_30d = excluded.volatility_30d,
    liquidity_score = excluded.liquidity_score,
    percentile_rank = excluded.percentile_rank,
    active_listings_7d = excluded.active_listings_7d,
    snapshot_count_30d = excluded.snapshot_count_30d,
    justtcg_price = excluded.justtcg_price,
    pokemontcg_price = excluded.pokemontcg_price,
    market_price = excluded.market_price,
    market_price_as_of = excluded.market_price_as_of,
    provider_compare_as_of = excluded.provider_compare_as_of,
    updated_at = excluded.updated_at;

  get diagnostics affected = row_count;

  with all_prices_raw as (
    select
      canonical_slug,
      printing_id,
      grade
    from public.price_snapshots
    where observed_at >= now() - interval '30 days'

    union

    select
      canonical_slug,
      printing_id,
      grade
    from public.listing_observations
    where source in ('EBAY', 'TCGPLAYER')
      and observed_at >= now() - interval '30 days'
      and price_value is not null
  ),
  active_keys as (
    select canonical_slug, printing_id, grade
    from all_prices_raw

    union

    select canonical_slug, null::uuid as printing_id, grade
    from all_prices_raw
    where printing_id is not null
  )
  delete from public.card_metrics cm
  where not exists (
    select 1
    from active_keys ak
    where ak.canonical_slug = cm.canonical_slug
      and ak.printing_id is not distinct from cm.printing_id
      and ak.grade = cm.grade
  );

  get diagnostics removed = row_count;

  return jsonb_build_object(
    'ok', true,
    'rows', affected,
    'rowsRemoved', removed
  );
end;
$$;

create or replace function public.refresh_price_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  nulled_count  int := 0;
  cutoff_8d     timestamptz := now() - interval '8 days';
  cutoff_7d     timestamptz := now() - interval '7 days';
  cutoff_6d     timestamptz := now() - interval '6 days';
  cutoff_36h    timestamptz := now() - interval '36 hours';
  cutoff_24h    timestamptz := now() - interval '24 hours';
begin
  with recent_points as (
    select
      canonical_slug,
      ts,
      price
    from public.price_history_points
    where provider in ('JUSTTCG', 'POKEMON_TCG_API')
      and source_window in ('snapshot', '30d')
      and ts >= cutoff_8d
  ),
  canonical_hourly as (
    select
      rp.canonical_slug,
      date_trunc('hour', rp.ts) as bucket_ts,
      percentile_cont(0.5) within group (order by rp.price) as canonical_price,
      count(*)::integer as points_in_bucket
    from recent_points rp
    group by rp.canonical_slug, date_trunc('hour', rp.ts)
  ),
  latest_price as (
    select distinct on (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price as price_now,
      ch.bucket_ts as latest_ts
    from canonical_hourly ch
    order by ch.canonical_slug, ch.bucket_ts desc, ch.points_in_bucket desc
  ),
  price_near_24h as (
    select distinct on (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price as price_24h,
      ch.bucket_ts as price_24h_ts
    from canonical_hourly ch
    where ch.bucket_ts between cutoff_36h and cutoff_24h
    order by
      ch.canonical_slug,
      abs(extract(epoch from (ch.bucket_ts - cutoff_24h))) asc,
      ch.bucket_ts desc,
      ch.points_in_bucket desc
  ),
  price_near_7d as (
    select distinct on (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price as price_7d,
      ch.bucket_ts as price_7d_ts
    from canonical_hourly ch
    where ch.bucket_ts between cutoff_8d and cutoff_6d
    order by
      ch.canonical_slug,
      abs(extract(epoch from (ch.bucket_ts - cutoff_7d))) asc,
      ch.bucket_ts desc,
      ch.points_in_bucket desc
  ),
  changes as (
    select
      lp.canonical_slug,
      case
        when p24.price_24h is not null
          and p24.price_24h > 0
          and lp.latest_ts > cutoff_24h
          and p24.price_24h_ts < lp.latest_ts
        then ((lp.price_now - p24.price_24h) / p24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when p7.price_7d is not null
          and p7.price_7d > 0
          and p7.price_7d_ts < lp.latest_ts
        then ((lp.price_now - p7.price_7d) / p7.price_7d) * 100
        else null
      end as change_pct_7d
    from latest_price lp
    left join price_near_24h p24 using (canonical_slug)
    left join price_near_7d p7 using (canonical_slug)
  ),
  do_update as (
    update public.card_metrics cm
    set
      change_pct_24h = c.change_pct_24h,
      change_pct_7d = c.change_pct_7d
    from changes c
    where cm.canonical_slug = c.canonical_slug
      and cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.change_pct_24h is distinct from c.change_pct_24h
        or cm.change_pct_7d is distinct from c.change_pct_7d
      )
    returning cm.id
  )
  select count(*) into updated_count from do_update;

  with slugs_with_history as (
    select distinct canonical_slug
    from public.price_history_points
    where provider in ('JUSTTCG', 'POKEMON_TCG_API')
      and source_window in ('snapshot', '30d')
      and ts >= cutoff_8d
  ),
  do_null as (
    update public.card_metrics cm
    set
      change_pct_24h = null,
      change_pct_7d = null
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.change_pct_24h is not null
        or cm.change_pct_7d is not null
      )
      and cm.canonical_slug not in (select canonical_slug from slugs_with_history)
    returning cm.id
  )
  select count(*) into nulled_count from do_null;

  return jsonb_build_object(
    'updated', updated_count,
    'nulled', nulled_count
  );
end;
$$;

drop view if exists public.public_card_metrics;
create view public.public_card_metrics as
select
  id, canonical_slug, printing_id, grade,
  median_7d, median_30d, low_30d, high_30d, trimmed_median_30d,
  volatility_30d, liquidity_score, percentile_rank, scarcity_adjusted_value,
  active_listings_7d, snapshot_count_30d,
  provider_trend_slope_7d, provider_trend_slope_30d,
  provider_cov_price_7d, provider_cov_price_30d,
  provider_price_relative_to_30d_range,
  provider_min_price_all_time, provider_min_price_all_time_date,
  provider_max_price_all_time, provider_max_price_all_time_date,
  provider_as_of_ts,
  provider_price_changes_count_30d,
  justtcg_price,
  pokemontcg_price,
  market_price,
  market_price_as_of,
  provider_compare_as_of,
  change_pct_24h,
  change_pct_7d,
  updated_at
from public.card_metrics;
grant select on public.public_card_metrics to anon, authenticated;
