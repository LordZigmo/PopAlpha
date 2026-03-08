create or replace function public.refresh_card_metrics_for_variants(keys jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  affected integer := 0;
  removed integer := 0;
  v_target_sets text[];
begin
  if keys is null or jsonb_typeof(keys) <> 'array' or jsonb_array_length(keys) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rows', 0,
      'rowsRemoved', 0,
      'setCount', 0
    );
  end if;

  with target_keys as (
    select distinct
      nullif(trim(item->>'canonical_slug'), '') as canonical_slug,
      case
        when split_part(coalesce(item->>'variant_ref', ''), '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(item->>'variant_ref', '::', 1)::uuid
        else null::uuid
      end as printing_id
    from jsonb_array_elements(keys) item
    where coalesce(item->>'canonical_slug', '') <> ''
  )
  select array_agg(distinct target_set_name)
  into v_target_sets
  from (
    select coalesce(cp.set_name, cc.set_name) as target_set_name
    from target_keys tk
    join public.canonical_cards cc
      on cc.slug = tk.canonical_slug
    left join public.card_printings cp
      on cp.id = tk.printing_id
    where coalesce(cp.set_name, cc.set_name) is not null
  ) scope;

  if v_target_sets is null or coalesce(array_length(v_target_sets, 1), 0) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rows', 0,
      'rowsRemoved', 0,
      'setCount', 0
    );
  end if;

  with all_prices_raw as (
    select
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    join public.canonical_cards cc
      on cc.slug = ps.canonical_slug
    left join public.card_printings cp
      on cp.id = ps.printing_id
    where ps.observed_at >= now() - interval '30 days'
      and coalesce(cp.set_name, cc.set_name) = any(v_target_sets)
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
    join public.canonical_cards cc
      on cc.slug = ps.canonical_slug
    left join public.card_printings cp
      on cp.id = ps.printing_id
    where ps.provider in ('JUSTTCG', 'SCRYDEX')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '30 days'
      and coalesce(cp.set_name, cc.set_name) = any(v_target_sets)
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
      max(case when provider = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider = 'JUSTTCG' then observed_at end) as justtcg_as_of,
      max(case when provider = 'SCRYDEX' then observed_at end) as scrydex_as_of
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
  history_points_expanded as (
    select
      ph.canonical_slug,
      case
        when split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(ph.variant_ref, '::', 1)::uuid
        else null::uuid
      end as printing_id,
      'RAW'::text as grade,
      ph.ts
    from public.price_history_points ph
    join public.canonical_cards cc
      on cc.slug = ph.canonical_slug
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window in ('snapshot', '30d')
      and ph.ts >= now() - interval '30 days'
  ),
  history_points_filtered as (
    select
      hpe.canonical_slug,
      hpe.printing_id,
      hpe.grade,
      hpe.ts
    from history_points_expanded hpe
    join public.canonical_cards cc
      on cc.slug = hpe.canonical_slug
    left join public.card_printings cp
      on cp.id = hpe.printing_id
    where coalesce(cp.set_name, cc.set_name) = any(v_target_sets)
  ),
  history_counts as (
    select
      canonical_slug,
      printing_id,
      grade,
      count(*) filter (where ts >= now() - interval '7 days')::integer as history_7d_count,
      count(*)::integer as history_count_30d
    from (
      select canonical_slug, printing_id, grade, ts from history_points_filtered
      union all
      select canonical_slug, null::uuid as printing_id, grade, ts
      from history_points_filtered
      where printing_id is not null
    ) x
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
        greatest(coalesce(hc.history_7d_count, 0), bs.snapshot_active_7d_count)::numeric * 20,
        100
      ) as liquidity_score,
      greatest(coalesce(hc.history_7d_count, 0), bs.snapshot_active_7d_count)::integer as active_7d_count,
      greatest(coalesce(hc.history_count_30d, 0), bs.snapshot_count_30d)::integer as snapshot_count_30d,
      pc.justtcg_price,
      pc.scrydex_price,
      case
        when pc.justtcg_price is not null and pc.scrydex_price is not null
          then round(((pc.justtcg_price + pc.scrydex_price) / 2.0)::numeric, 4)
        else coalesce(pc.justtcg_price, pc.scrydex_price)
      end as market_price,
      greatest(pc.justtcg_as_of, pc.scrydex_as_of) as market_price_as_of,
      greatest(pc.justtcg_as_of, pc.scrydex_as_of) as provider_compare_as_of
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
    join public.canonical_cards cc
      on cc.slug = c.canonical_slug
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
    scrydex_price,
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
    r.scrydex_price,
    r.scrydex_price,
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
    scrydex_price = excluded.scrydex_price,
    pokemontcg_price = excluded.pokemontcg_price,
    market_price = excluded.market_price,
    market_price_as_of = excluded.market_price_as_of,
    provider_compare_as_of = excluded.provider_compare_as_of,
    updated_at = excluded.updated_at;

  get diagnostics affected = row_count;

  with active_keys as (
    select
      ps.canonical_slug,
      ps.printing_id,
      ps.grade
    from public.price_snapshots ps
    join public.canonical_cards cc
      on cc.slug = ps.canonical_slug
    left join public.card_printings cp
      on cp.id = ps.printing_id
    where ps.observed_at >= now() - interval '30 days'
      and coalesce(cp.set_name, cc.set_name) = any(v_target_sets)

    union

    select
      ps.canonical_slug,
      null::uuid as printing_id,
      ps.grade
    from public.price_snapshots ps
    join public.canonical_cards cc
      on cc.slug = ps.canonical_slug
    left join public.card_printings cp
      on cp.id = ps.printing_id
    where ps.observed_at >= now() - interval '30 days'
      and ps.printing_id is not null
      and coalesce(cp.set_name, cc.set_name) = any(v_target_sets)
  ),
  delete_scope as (
    select cm.id
    from public.card_metrics cm
    join public.canonical_cards cc
      on cc.slug = cm.canonical_slug
    left join public.card_printings cp
      on cp.id = cm.printing_id
    where coalesce(cp.set_name, cc.set_name) = any(v_target_sets)
      and not exists (
        select 1
        from active_keys ak
        where ak.canonical_slug = cm.canonical_slug
          and ak.printing_id is not distinct from cm.printing_id
          and ak.grade = cm.grade
      )
  )
  delete from public.card_metrics cm
  using delete_scope ds
  where cm.id = ds.id;

  get diagnostics removed = row_count;

  return jsonb_build_object(
    'ok', true,
    'rows', affected,
    'rowsRemoved', removed,
    'setCount', coalesce(array_length(v_target_sets, 1), 0)
  );
end;
$$;

create or replace function public.refresh_price_changes_for_cards(p_canonical_slugs text[])
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  nulled_count int := 0;
  cutoff_8d timestamptz := now() - interval '8 days';
  cutoff_7d timestamptz := now() - interval '7 days';
  cutoff_6d timestamptz := now() - interval '6 days';
  cutoff_36h timestamptz := now() - interval '36 hours';
  cutoff_24h timestamptz := now() - interval '24 hours';
begin
  if p_canonical_slugs is null or coalesce(array_length(p_canonical_slugs, 1), 0) = 0 then
    return jsonb_build_object(
      'updated', 0,
      'nulled', 0
    );
  end if;

  with canonical_scope as (
    select cm.canonical_slug
    from public.card_metrics cm
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and cm.canonical_slug = any(p_canonical_slugs)
    group by cm.canonical_slug
  ),
  snapshot_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = 'snapshot'
      and ph.ts >= cutoff_8d
  ),
  slugs_with_snapshot as (
    select distinct canonical_slug
    from snapshot_points
  ),
  fallback_30d_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    left join slugs_with_snapshot s using (canonical_slug)
    where s.canonical_slug is null
      and ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = '30d'
      and ph.ts >= cutoff_8d
  ),
  recent_points as (
    select * from snapshot_points
    union all
    select * from fallback_30d_points
  ),
  canonical_hourly as (
    select
      rp.canonical_slug,
      date_trunc('hour', rp.ts) as bucket_ts,
      avg(rp.price)::numeric as canonical_price,
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

  with canonical_scope as (
    select distinct canonical_slug
    from unnest(p_canonical_slugs) as canonical_slug
    where canonical_slug is not null and trim(canonical_slug) <> ''
  ),
  snapshot_points as (
    select
      ph.canonical_slug
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = 'snapshot'
      and ph.ts >= cutoff_8d
  ),
  slugs_with_snapshot as (
    select distinct canonical_slug
    from snapshot_points
  ),
  fallback_30d_points as (
    select
      ph.canonical_slug
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    left join slugs_with_snapshot s using (canonical_slug)
    where s.canonical_slug is null
      and ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = '30d'
      and ph.ts >= cutoff_8d
  ),
  slugs_with_history as (
    select canonical_slug from snapshot_points
    union
    select canonical_slug from fallback_30d_points
  ),
  do_null as (
    update public.card_metrics cm
    set
      change_pct_24h = null,
      change_pct_7d = null
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and cm.canonical_slug = any(p_canonical_slugs)
      and (
        cm.change_pct_24h is not null
        or cm.change_pct_7d is not null
      )
      and not exists (
        select 1
        from slugs_with_history s
        where s.canonical_slug = cm.canonical_slug
      )
    returning cm.id
  )
  select count(*) into nulled_count from do_null;

  return jsonb_build_object(
    'updated', updated_count,
    'nulled', nulled_count
  );
end;
$$;

create or replace function public.refresh_card_market_confidence_for_cards(p_canonical_slugs text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected integer := 0;
begin
  if p_canonical_slugs is null or coalesce(array_length(p_canonical_slugs, 1), 0) = 0 then
    return jsonb_build_object(
      'ok', true,
      'affected', 0
    );
  end if;

  with provider_latest as (
    select
      vm.canonical_slug,
      max(case when vm.provider = 'JUSTTCG' then vm.provider_as_of_ts end) as justtcg_as_of,
      max(case when vm.provider in ('SCRYDEX','POKEMON_TCG_API') then vm.provider_as_of_ts end) as scrydex_as_of
    from public.variant_metrics vm
    where vm.grade = 'RAW'
      and vm.printing_id is null
      and vm.provider in ('JUSTTCG','SCRYDEX','POKEMON_TCG_API')
      and vm.canonical_slug = any(p_canonical_slugs)
    group by vm.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
      count(*) filter (where ph.provider in ('SCRYDEX','POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history_points ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('JUSTTCG','SCRYDEX','POKEMON_TCG_API')
      and ph.canonical_slug = any(p_canonical_slugs)
    group by ph.canonical_slug
  ),
  base as (
    select
      cm.id,
      cm.canonical_slug,
      cm.justtcg_price,
      cm.scrydex_price,
      p.parity_status,
      pl.justtcg_as_of,
      pl.scrydex_as_of,
      coalesce(pc.justtcg_points_7d, 0) as justtcg_points_7d,
      coalesce(pc.scrydex_points_7d, 0) as scrydex_points_7d,
      case
        when cm.justtcg_price is not null and cm.scrydex_price is not null and (cm.justtcg_price + cm.scrydex_price) > 0
          then abs(cm.justtcg_price - cm.scrydex_price) / ((cm.justtcg_price + cm.scrydex_price) / 2) * 100
        else null
      end as divergence_pct,
      case
        when cm.justtcg_price is not null and cm.scrydex_price is not null and least(cm.justtcg_price, cm.scrydex_price) > 0
          then greatest(cm.justtcg_price, cm.scrydex_price) / least(cm.justtcg_price, cm.scrydex_price)
        else null
      end as ratio
    from public.card_metrics cm
    left join public.canonical_raw_provider_parity p
      on p.canonical_slug = cm.canonical_slug
    left join provider_latest pl
      on pl.canonical_slug = cm.canonical_slug
    left join provider_counts pc
      on pc.canonical_slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cm.printing_id is null
      and cm.canonical_slug = any(p_canonical_slugs)
  ),
  weighted as (
    select
      b.*,
      (case when b.justtcg_price is null then 0 else 1 end)
      * (case
          when b.justtcg_as_of is null then 0.55
          when now() - b.justtcg_as_of <= interval '3 hours' then 1
          when now() - b.justtcg_as_of <= interval '6 hours' then 0.95
          when now() - b.justtcg_as_of <= interval '24 hours' then 0.85
          when now() - b.justtcg_as_of <= interval '72 hours' then 0.6
          when now() - b.justtcg_as_of <= interval '168 hours' then 0.35
          else 0.15
        end)
      * (0.4 + least(1, b.justtcg_points_7d / 80.0) * 0.6)
      * (case when b.parity_status = 'MATCH' then 1 when b.parity_status = 'UNKNOWN' then 0.92 else 0.72 end)
      * (case when b.divergence_pct is null then 1 else greatest(0.25, 1 - least(0.75, b.divergence_pct / 220.0)) end)
      * (case when b.ratio is not null and b.ratio >= 3.5 and b.justtcg_price > b.scrydex_price then 0.03 else 1 end)
      * (case when b.justtcg_as_of is not null and now() - b.justtcg_as_of > interval '168 hours' then 0.05 else 1 end)
      as w_justtcg,

      (case when b.scrydex_price is null then 0 else 0.96 end)
      * (case
          when b.scrydex_as_of is null then 0.55
          when now() - b.scrydex_as_of <= interval '3 hours' then 1
          when now() - b.scrydex_as_of <= interval '6 hours' then 0.95
          when now() - b.scrydex_as_of <= interval '24 hours' then 0.85
          when now() - b.scrydex_as_of <= interval '72 hours' then 0.6
          when now() - b.scrydex_as_of <= interval '168 hours' then 0.35
          else 0.15
        end)
      * (0.4 + least(1, b.scrydex_points_7d / 80.0) * 0.6)
      * (case when b.parity_status = 'MATCH' then 1 when b.parity_status = 'UNKNOWN' then 0.92 else 0.72 end)
      * (case when b.divergence_pct is null then 1 else greatest(0.25, 1 - least(0.75, b.divergence_pct / 220.0)) end)
      * (case when b.ratio is not null and b.ratio >= 3.5 and b.scrydex_price > b.justtcg_price then 0.03 else 1 end)
      * (case when b.scrydex_as_of is not null and now() - b.scrydex_as_of > interval '168 hours' then 0.05 else 1 end)
      as w_scrydex
    from base b
  ),
  normalized as (
    select
      w.*,
      (w.w_justtcg + w.w_scrydex) as w_total,
      case
        when (w.w_justtcg + w.w_scrydex) > 0 then w.w_justtcg / (w.w_justtcg + w.w_scrydex)
        else 0
      end as source_mix_justtcg,
      case
        when (w.w_justtcg + w.w_scrydex) > 0 then w.w_scrydex / (w.w_justtcg + w.w_scrydex)
        else 0
      end as source_mix_scrydex
    from weighted w
  ),
  updates as (
    select
      n.id,
      case
        when n.justtcg_price is null and n.scrydex_price is null then 0
        else round(((
          (case when n.justtcg_price is not null and n.scrydex_price is not null then 1 else 0.55 end) * 0.25 +
          (case
            when n.w_total <= 0 then 0
            else (
              n.source_mix_justtcg * (1 - least(1, coalesce(extract(epoch from (now() - n.justtcg_as_of)) / 3600.0, 36) / 168.0)) +
              n.source_mix_scrydex * (1 - least(1, coalesce(extract(epoch from (now() - n.scrydex_as_of)) / 3600.0, 36) / 168.0))
            )
          end) * 0.25 +
          (case when n.divergence_pct is null then 0.5 else greatest(0, 1 - least(1, n.divergence_pct / 120.0)) end) * 0.3 +
          (case when n.parity_status = 'MATCH' then 1 when n.parity_status = 'UNKNOWN' then 0.7 else 0.4 end) * 0.2
        ) * 100)::numeric, 0)
      end as confidence_score,
      case
        when n.justtcg_price is null and n.scrydex_price is null then true
        when n.justtcg_price is null or n.scrydex_price is null then true
        when n.w_total <= 0.01 then true
        else false
      end as low_confidence,
      case
        when n.justtcg_price is null and n.scrydex_price is null then 'NO_PRICE'
        when n.justtcg_price is null or n.scrydex_price is null then 'SINGLE_PROVIDER'
        when n.w_total <= 0.01 then 'FALLBACK_STALE_OR_OUTLIER'
        when (n.ratio is not null and n.ratio >= 3.5) then 'FALLBACK_STALE_OR_OUTLIER'
        else 'TRUST_WEIGHTED_BLEND'
      end as blend_policy,
      jsonb_build_object(
        'sourceMix', jsonb_build_object(
          'justtcgWeight', round((n.source_mix_justtcg)::numeric, 4),
          'scrydexWeight', round((n.source_mix_scrydex)::numeric, 4)
        ),
        'providerWeights', jsonb_build_array(
          jsonb_build_object(
            'provider', 'JUSTTCG',
            'weight', round((case when n.w_total > 0 then n.source_mix_justtcg else 0 end)::numeric, 4),
            'points7d', n.justtcg_points_7d,
            'lastUpdate', n.justtcg_as_of
          ),
          jsonb_build_object(
            'provider', 'SCRYDEX',
            'weight', round((case when n.w_total > 0 then n.source_mix_scrydex else 0 end)::numeric, 4),
            'points7d', n.scrydex_points_7d,
            'lastUpdate', n.scrydex_as_of
          )
        ),
        'providerDivergencePct', round(coalesce(n.divergence_pct, 0)::numeric, 2),
        'sampleCounts7d', jsonb_build_object(
          'justtcg', n.justtcg_points_7d,
          'scrydex', n.scrydex_points_7d
        ),
        'parityStatus', coalesce(n.parity_status, 'UNKNOWN')
      ) as provenance
    from normalized n
  )
  update public.card_metrics cm
  set
    market_confidence_score = u.confidence_score,
    market_low_confidence = u.low_confidence,
    market_blend_policy = u.blend_policy,
    market_provenance = u.provenance,
    updated_at = now()
  from updates u
  where cm.id = u.id;

  get diagnostics v_affected = row_count;

  return jsonb_build_object(
    'ok', true,
    'affected', v_affected
  );
end;
$$;

create or replace function public.refresh_canonical_raw_provider_parity_for_cards(
  p_canonical_slugs text[],
  p_window_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if p_canonical_slugs is null or coalesce(array_length(p_canonical_slugs, 1), 0) = 0 then
    return 0;
  end if;

  with matched as (
    select
      m.canonical_slug,
      m.provider,
      coalesce(o.normalized_finish, 'UNKNOWN') as normalized_finish,
      coalesce(o.normalized_edition, 'UNLIMITED') as normalized_edition,
      coalesce(o.normalized_stamp, 'NONE') as normalized_stamp,
      o.observed_at
    from public.provider_observation_matches m
    join public.provider_normalized_observations o
      on o.id = m.provider_normalized_observation_id
     and o.provider = m.provider
    where m.match_status = 'MATCHED'
      and m.canonical_slug is not null
      and m.canonical_slug = any(p_canonical_slugs)
      and m.provider in ('JUSTTCG', 'SCRYDEX')
      and o.observed_price is not null
      and o.observed_at >= now() - make_interval(days => greatest(1, coalesce(p_window_days, 30)))
  ),
  profile_counts as (
    select
      canonical_slug,
      provider,
      normalized_finish,
      normalized_edition,
      normalized_stamp,
      count(*)::integer as points_30d,
      max(observed_at) as latest_observed_at
    from matched
    group by canonical_slug, provider, normalized_finish, normalized_edition, normalized_stamp
  ),
  provider_top as (
    select *
    from (
      select
        pc.*,
        row_number() over (
          partition by pc.canonical_slug, pc.provider
          order by pc.points_30d desc, pc.latest_observed_at desc
        ) as rn
      from profile_counts pc
    ) ranked
    where rn = 1
  ),
  joined as (
    select
      c.slug as canonical_slug,
      j.normalized_finish as justtcg_finish,
      j.normalized_edition as justtcg_edition,
      j.normalized_stamp as justtcg_stamp,
      coalesce(j.points_30d, 0) as justtcg_points_30d,
      j.latest_observed_at as justtcg_as_of,
      s.normalized_finish as scrydex_finish,
      s.normalized_edition as scrydex_edition,
      s.normalized_stamp as scrydex_stamp,
      coalesce(s.points_30d, 0) as scrydex_points_30d,
      s.latest_observed_at as scrydex_as_of,
      case
        when j.canonical_slug is null and s.canonical_slug is null then 'UNKNOWN'
        when j.canonical_slug is null or s.canonical_slug is null then 'MISSING_PROVIDER'
        when j.normalized_finish = s.normalized_finish
          and j.normalized_edition = s.normalized_edition
          and coalesce(j.normalized_stamp, 'NONE') = coalesce(s.normalized_stamp, 'NONE')
          then 'MATCH'
        else 'MISMATCH'
      end as parity_status
    from public.canonical_cards c
    left join provider_top j
      on j.canonical_slug = c.slug and j.provider = 'JUSTTCG'
    left join provider_top s
      on s.canonical_slug = c.slug and s.provider = 'SCRYDEX'
    where c.slug = any(p_canonical_slugs)
  )
  insert into public.canonical_raw_provider_parity (
    canonical_slug,
    justtcg_finish,
    justtcg_edition,
    justtcg_stamp,
    justtcg_points_30d,
    justtcg_as_of,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    updated_at
  )
  select
    canonical_slug,
    justtcg_finish,
    justtcg_edition,
    justtcg_stamp,
    justtcg_points_30d,
    justtcg_as_of,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    now()
  from joined
  on conflict (canonical_slug) do update
    set
      justtcg_finish = excluded.justtcg_finish,
      justtcg_edition = excluded.justtcg_edition,
      justtcg_stamp = excluded.justtcg_stamp,
      justtcg_points_30d = excluded.justtcg_points_30d,
      justtcg_as_of = excluded.justtcg_as_of,
      scrydex_finish = excluded.scrydex_finish,
      scrydex_edition = excluded.scrydex_edition,
      scrydex_stamp = excluded.scrydex_stamp,
      scrydex_points_30d = excluded.scrydex_points_30d,
      scrydex_as_of = excluded.scrydex_as_of,
      parity_status = excluded.parity_status,
      updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
