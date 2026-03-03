-- 20260304120000_refresh_card_metrics_use_history_counts.sql
--
-- Keep card_metrics price aggregates sourced from price_snapshots/listing_observations,
-- but compute count-based fields from the richer price_history_points stream when it
-- exists. This fixes thin current-snapshot rows (for example one JUSTTCG snapshot row)
-- from collapsing active_listings_7d even when we have many real observations.

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
      )::integer as snapshot_count_30d
    from base_stats bs
    left join trimmed t
      on t.canonical_slug = bs.canonical_slug
     and t.printing_id is not distinct from bs.printing_id
     and t.grade = bs.grade
    left join history_counts hc
      on hc.canonical_slug = bs.canonical_slug
     and hc.printing_id is not distinct from bs.printing_id
     and hc.grade = bs.grade
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
