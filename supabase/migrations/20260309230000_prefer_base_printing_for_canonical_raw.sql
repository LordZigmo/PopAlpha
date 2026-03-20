-- Prefer the base RAW printing for canonical market price and change rollups:
-- English, unlimited, unstamped, then NON_HOLO -> HOLO -> REVERSE_HOLO.

create or replace function public.preferred_canonical_raw_printing(p_canonical_slug text)
returns uuid
language sql
stable
set search_path = public
as $$
  select cp.id
  from public.card_printings cp
  where cp.canonical_slug = p_canonical_slug
  order by
    case when upper(coalesce(cp.language, 'EN')) = 'EN' then 0 else 1 end,
    case when cp.edition = 'UNLIMITED' then 0 when cp.edition = 'UNKNOWN' then 1 else 2 end,
    case when cp.stamp is null or btrim(cp.stamp) = '' then 0 else 1 end,
    case cp.finish
      when 'NON_HOLO' then 0
      when 'HOLO' then 1
      when 'REVERSE_HOLO' then 2
      when 'ALT_HOLO' then 3
      else 4
    end,
    cp.updated_at desc,
    cp.id
  limit 1;
$$;

create or replace function public.refresh_card_metrics()
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
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end
    )
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '30 days'
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest_all as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  printing_compare as (
    select
      canonical_slug,
      printing_id,
      grade,
      max(case when provider_key = 'JUSTTCG' then price_value end) as justtcg_price,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'JUSTTCG' then observed_at end) as justtcg_as_of,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_raw
    group by canonical_slug, printing_id, grade
  ),
  canonical_fallback_compare as (
    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      max(case when provider_key = 'JUSTTCG' then price_value end) as justtcg_price,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'JUSTTCG' then observed_at end) as justtcg_as_of,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_all
    where printing_id is null
    group by canonical_slug, grade
  ),
  canonical_compare as (
    select
      scope.canonical_slug,
      null::uuid as printing_id,
      'RAW'::text as grade,
      coalesce(pref.justtcg_price, fallback.justtcg_price) as justtcg_price,
      coalesce(pref.scrydex_price, fallback.scrydex_price) as scrydex_price,
      coalesce(pref.justtcg_as_of, fallback.justtcg_as_of) as justtcg_as_of,
      coalesce(pref.scrydex_as_of, fallback.scrydex_as_of) as scrydex_as_of
    from (
      select distinct canonical_slug
      from all_prices
      where printing_id is null
        and grade = 'RAW'
    ) scope
    left join printing_compare pref
      on pref.canonical_slug = scope.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(scope.canonical_slug)
     and pref.grade = 'RAW'
    left join canonical_fallback_compare fallback
      on fallback.canonical_slug = scope.canonical_slug
     and fallback.grade = 'RAW'
  ),
  provider_compare as (
    select * from printing_compare
    union all
    select * from canonical_compare
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
    where ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '30d')
      and ph.ts >= now() - interval '30 days'
  ),
  history_counts as (
    select
      canonical_slug,
      printing_id,
      grade,
      count(*) filter (where ts >= now() - interval '7 days')::integer as history_7d_count,
      count(*)::integer as history_count_30d
    from (
      select canonical_slug, printing_id, grade, ts from history_points_expanded
      union all
      select canonical_slug, null::uuid as printing_id, grade, ts
      from history_points_expanded
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
      coalesce(pc.scrydex_price, pc.justtcg_price) as market_price,
      coalesce(pc.scrydex_as_of, pc.justtcg_as_of) as market_price_as_of,
      coalesce(greatest(pc.justtcg_as_of, pc.scrydex_as_of), pc.scrydex_as_of, pc.justtcg_as_of) as provider_compare_as_of
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
    where ps.observed_at >= now() - interval '30 days'

    union

    select
      ps.canonical_slug,
      null::uuid as printing_id,
      ps.grade
    from public.price_snapshots ps
    where ps.observed_at >= now() - interval '30 days'
      and ps.printing_id is not null
  ),
  delete_scope as (
    select cm.id
    from public.card_metrics cm
    where not exists (
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
    'rowsRemoved', removed
  );
end;
$$;

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
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end
    )
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    join public.canonical_cards cc
      on cc.slug = ps.canonical_slug
    left join public.card_printings cp
      on cp.id = ps.printing_id
    where ps.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '30 days'
      and coalesce(cp.set_name, cc.set_name) = any(v_target_sets)
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest_all as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  printing_compare as (
    select
      canonical_slug,
      printing_id,
      grade,
      max(case when provider_key = 'JUSTTCG' then price_value end) as justtcg_price,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'JUSTTCG' then observed_at end) as justtcg_as_of,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_raw
    group by canonical_slug, printing_id, grade
  ),
  canonical_fallback_compare as (
    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      max(case when provider_key = 'JUSTTCG' then price_value end) as justtcg_price,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'JUSTTCG' then observed_at end) as justtcg_as_of,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_all
    where printing_id is null
    group by canonical_slug, grade
  ),
  canonical_compare as (
    select
      scope.canonical_slug,
      null::uuid as printing_id,
      'RAW'::text as grade,
      coalesce(pref.justtcg_price, fallback.justtcg_price) as justtcg_price,
      coalesce(pref.scrydex_price, fallback.scrydex_price) as scrydex_price,
      coalesce(pref.justtcg_as_of, fallback.justtcg_as_of) as justtcg_as_of,
      coalesce(pref.scrydex_as_of, fallback.scrydex_as_of) as scrydex_as_of
    from (
      select distinct canonical_slug
      from all_prices
      where printing_id is null
        and grade = 'RAW'
    ) scope
    left join printing_compare pref
      on pref.canonical_slug = scope.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(scope.canonical_slug)
     and pref.grade = 'RAW'
    left join canonical_fallback_compare fallback
      on fallback.canonical_slug = scope.canonical_slug
     and fallback.grade = 'RAW'
  ),
  provider_compare as (
    select * from printing_compare
    union all
    select * from canonical_compare
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
    where ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
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
      coalesce(pc.scrydex_price, pc.justtcg_price) as market_price,
      coalesce(pc.scrydex_as_of, pc.justtcg_as_of) as market_price_as_of,
      coalesce(greatest(pc.justtcg_as_of, pc.scrydex_as_of), pc.scrydex_as_of, pc.justtcg_as_of) as provider_compare_as_of
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

create or replace function public.refresh_price_changes_core(p_canonical_slugs text[] default null)
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
  cutoff_14d timestamptz := now() - interval '14 days';
  cutoff_8d timestamptz := now() - interval '8 days';
  cutoff_7d timestamptz := now() - interval '7 days';
  cutoff_6d timestamptz := now() - interval '6 days';
  cutoff_96h timestamptz := now() - interval '96 hours';
  cutoff_36h timestamptz := now() - interval '36 hours';
  cutoff_24h timestamptz := now() - interval '24 hours';
begin
  with canonical_scope as (
    select distinct on (cm.canonical_slug)
      cm.canonical_slug,
      cm.scrydex_price as current_scrydex_price,
      cm.justtcg_price as current_justtcg_price,
      public.preferred_canonical_raw_printing(cm.canonical_slug) as preferred_printing_id
    from public.card_metrics cm
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and cm.canonical_slug is not null
      and (
        p_canonical_slugs is null
        or cm.canonical_slug = any(p_canonical_slugs)
      )
    order by cm.canonical_slug, cm.updated_at desc, cm.id desc
  ),
  base_points as (
    select
      ph.canonical_slug,
      case
        when ph.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ph.provider
      end as provider_key,
      ph.variant_ref,
      ph.ts,
      ph.price,
      case
        when ph.source_window = 'snapshot' then 1
        when ph.source_window = '7d' then 2
        when ph.source_window = '30d' then 3
        else 9
      end::int as source_priority,
      ph.source_window
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '7d', '30d')
      and ph.ts >= cutoff_14d
      and ph.price is not null
      and ph.price > 0
      and (
        cs.preferred_printing_id is null
        or split_part(ph.variant_ref, '::', 1) = cs.preferred_printing_id::text
      )
  ),
  provider_candidates as (
    select
      bp.canonical_slug,
      bp.provider_key,
      max(bp.ts) as latest_ts,
      count(*) filter (where bp.source_window = 'snapshot' and bp.ts >= cutoff_8d)::integer as recent_snapshot_points,
      count(*) filter (where bp.ts >= cutoff_8d)::integer as recent_points,
      count(*)::integer as total_points
    from base_points bp
    group by bp.canonical_slug, bp.provider_key
  ),
  preferred_provider as (
    select distinct on (pc.canonical_slug)
      pc.canonical_slug,
      pc.provider_key,
      case
        when pc.provider_key = 'SCRYDEX' then cs.current_scrydex_price
        else cs.current_justtcg_price
      end as current_provider_price
    from provider_candidates pc
    join canonical_scope cs
      on cs.canonical_slug = pc.canonical_slug
    order by
      pc.canonical_slug,
      case
        when cs.current_scrydex_price is not null and pc.provider_key = 'SCRYDEX' then 5
        when cs.current_justtcg_price is not null and pc.provider_key = 'JUSTTCG' then 5
        when pc.recent_snapshot_points > 0 then 4
        when pc.recent_points > 0 then 3
        when pc.total_points > 0 then 1
        else 0
      end desc,
      case when pc.provider_key = 'SCRYDEX' then 1 else 0 end desc,
      pc.latest_ts desc
  ),
  variant_latest_points as (
    select distinct on (bp.canonical_slug, bp.provider_key, bp.variant_ref)
      bp.canonical_slug,
      bp.provider_key,
      bp.variant_ref,
      bp.ts as latest_ts,
      bp.price as latest_price,
      bp.source_priority
    from base_points bp
    join preferred_provider pp
      on pp.canonical_slug = bp.canonical_slug
     and pp.provider_key = bp.provider_key
    order by
      bp.canonical_slug,
      bp.provider_key,
      bp.variant_ref,
      bp.ts desc,
      bp.source_priority asc
  ),
  preferred_variant as (
    select distinct on (vlp.canonical_slug)
      vlp.canonical_slug,
      vlp.provider_key,
      vlp.variant_ref
    from variant_latest_points vlp
    join preferred_provider pp
      on pp.canonical_slug = vlp.canonical_slug
     and pp.provider_key = vlp.provider_key
    order by
      vlp.canonical_slug,
      case when vlp.latest_ts >= cutoff_8d then 2 else 1 end desc,
      case
        when pp.current_provider_price is not null
          then abs(vlp.latest_price - pp.current_provider_price)
        else 0
      end asc,
      vlp.source_priority asc,
      vlp.latest_ts desc
  ),
  preferred_points as (
    select bp.*
    from base_points bp
    join preferred_variant pv
      on pv.canonical_slug = bp.canonical_slug
     and pv.provider_key = bp.provider_key
     and pv.variant_ref = bp.variant_ref
  ),
  hourly_source_rank as (
    select
      pp.canonical_slug,
      date_trunc('hour', pp.ts) as bucket_ts,
      pp.source_priority,
      avg(pp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket,
      max(pp.ts) as latest_point_ts
    from preferred_points pp
    group by pp.canonical_slug, date_trunc('hour', pp.ts), pp.source_priority
  ),
  hourly_points as (
    select distinct on (hsr.canonical_slug, hsr.bucket_ts)
      hsr.canonical_slug,
      hsr.bucket_ts,
      hsr.canonical_price,
      hsr.points_in_bucket,
      hsr.source_priority,
      hsr.latest_point_ts
    from hourly_source_rank hsr
    order by
      hsr.canonical_slug,
      hsr.bucket_ts,
      hsr.source_priority asc,
      hsr.latest_point_ts desc,
      hsr.points_in_bucket desc
  ),
  latest_price as (
    select distinct on (hp.canonical_slug)
      hp.canonical_slug,
      hp.canonical_price as price_now,
      hp.bucket_ts as latest_ts
    from hourly_points hp
    where hp.bucket_ts >= cutoff_8d
    order by
      hp.canonical_slug,
      hp.bucket_ts desc,
      hp.source_priority asc,
      hp.points_in_bucket desc
  ),
  price_exact_24h as (
    select distinct on (hp.canonical_slug)
      hp.canonical_slug,
      hp.canonical_price as price_24h,
      hp.bucket_ts as price_24h_ts
    from hourly_points hp
    where hp.bucket_ts between cutoff_36h and cutoff_24h
    order by
      hp.canonical_slug,
      hp.source_priority asc,
      abs(extract(epoch from (hp.bucket_ts - cutoff_24h))) asc,
      hp.bucket_ts desc,
      hp.points_in_bucket desc
  ),
  price_fallback_24h as (
    select distinct on (hp.canonical_slug)
      hp.canonical_slug,
      hp.canonical_price as price_24h,
      hp.bucket_ts as price_24h_ts
    from hourly_points hp
    where hp.bucket_ts between cutoff_96h and cutoff_24h
    order by
      hp.canonical_slug,
      hp.source_priority asc,
      hp.bucket_ts desc,
      hp.points_in_bucket desc
  ),
  resolved_24h as (
    select
      coalesce(e.canonical_slug, f.canonical_slug) as canonical_slug,
      coalesce(e.price_24h, f.price_24h) as price_24h,
      coalesce(e.price_24h_ts, f.price_24h_ts) as price_24h_ts
    from price_exact_24h e
    full outer join price_fallback_24h f using (canonical_slug)
  ),
  price_exact_7d as (
    select distinct on (hp.canonical_slug)
      hp.canonical_slug,
      hp.canonical_price as price_7d,
      hp.bucket_ts as price_7d_ts
    from hourly_points hp
    where hp.bucket_ts between cutoff_8d and cutoff_6d
    order by
      hp.canonical_slug,
      hp.source_priority asc,
      abs(extract(epoch from (hp.bucket_ts - cutoff_7d))) asc,
      hp.bucket_ts desc,
      hp.points_in_bucket desc
  ),
  price_fallback_7d as (
    select distinct on (hp.canonical_slug)
      hp.canonical_slug,
      hp.canonical_price as price_7d,
      hp.bucket_ts as price_7d_ts
    from hourly_points hp
    where hp.bucket_ts between cutoff_14d and cutoff_7d
    order by
      hp.canonical_slug,
      hp.source_priority asc,
      hp.bucket_ts desc,
      hp.points_in_bucket desc
  ),
  resolved_7d as (
    select
      coalesce(e.canonical_slug, f.canonical_slug) as canonical_slug,
      coalesce(e.price_7d, f.price_7d) as price_7d,
      coalesce(e.price_7d_ts, f.price_7d_ts) as price_7d_ts
    from price_exact_7d e
    full outer join price_fallback_7d f using (canonical_slug)
  ),
  changes as (
    select
      cs.canonical_slug,
      case
        when lp.price_now is not null
          and r24.price_24h is not null
          and r24.price_24h > 0
          and lp.latest_ts > cutoff_24h
          and r24.price_24h_ts < lp.latest_ts
        then ((lp.price_now - r24.price_24h) / r24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when lp.price_now is not null
          and r7.price_7d is not null
          and r7.price_7d > 0
          and r7.price_7d_ts < lp.latest_ts
        then ((lp.price_now - r7.price_7d) / r7.price_7d) * 100
        else null
      end as change_pct_7d
    from canonical_scope cs
    left join latest_price lp using (canonical_slug)
    left join resolved_24h r24 using (canonical_slug)
    left join resolved_7d r7 using (canonical_slug)
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
    returning case
      when c.change_pct_24h is null and c.change_pct_7d is null then 1
      else 0
    end as nulled_flag
  )
  select
    count(*),
    coalesce(sum(nulled_flag), 0)
  into updated_count, nulled_count
  from do_update;

  return jsonb_build_object(
    'updated', updated_count,
    'nulled', nulled_count
  );
end;
$$;

create or replace function public.refresh_card_market_confidence_core(p_canonical_slugs text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected integer := 0;
begin
  with provider_latest_raw as (
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end
    )
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.observed_at
    from public.price_snapshots ps
    where ps.grade = 'RAW'
      and ps.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ps.observed_at >= now() - interval '30 days'
      and (
        p_canonical_slugs is null
        or ps.canonical_slug = any(p_canonical_slugs)
      )
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  provider_latest_canonical as (
    select
      pl.canonical_slug,
      max(case when pl.provider_key = 'JUSTTCG' then pl.observed_at end) as justtcg_as_of,
      max(case when pl.provider_key = 'SCRYDEX' then pl.observed_at end) as scrydex_as_of
    from provider_latest pl
    where pl.grade = 'RAW'
      and pl.printing_id is null
    group by pl.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
      count(*) filter (where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history_points ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and (
        p_canonical_slugs is null
        or ph.canonical_slug = any(p_canonical_slugs)
      )
    group by ph.canonical_slug
  ),
  base as (
    select
      cm.id,
      cm.canonical_slug,
      cm.justtcg_price,
      cm.scrydex_price,
      cm.market_price as current_market_price,
      cm.market_price_as_of as current_market_price_as_of,
      cm.median_7d,
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
    left join provider_latest_canonical pl
      on pl.canonical_slug = cm.canonical_slug
    left join provider_counts pc
      on pc.canonical_slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cm.printing_id is null
      and (
        p_canonical_slugs is null
        or cm.canonical_slug = any(p_canonical_slugs)
      )
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
      as w_scrydex,

      (b.justtcg_as_of is not null and now() - b.justtcg_as_of > interval '168 hours') as justtcg_stale,
      (b.scrydex_as_of is not null and now() - b.scrydex_as_of > interval '168 hours') as scrydex_stale,
      (b.ratio is not null and b.ratio >= 3.5 and b.justtcg_price > b.scrydex_price) as justtcg_outlier,
      (b.ratio is not null and b.ratio >= 3.5 and b.scrydex_price > b.justtcg_price) as scrydex_outlier
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
      end as source_mix_scrydex,
      case
        when w.justtcg_stale then 'STALE'
        when w.justtcg_outlier then 'OUTLIER'
        else null
      end as justtcg_excluded_reason,
      case
        when w.scrydex_stale then 'STALE'
        when w.scrydex_outlier then 'OUTLIER'
        else null
      end as scrydex_excluded_reason
    from weighted w
  ),
  scored as (
    select
      n.*,
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
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then round(n.scrydex_price::numeric, 4)
        when n.justtcg_price is not null and n.justtcg_excluded_reason is null then round(n.justtcg_price::numeric, 4)
        when n.scrydex_price is not null then round(n.scrydex_price::numeric, 4)
        when n.justtcg_price is not null then round(n.justtcg_price::numeric, 4)
        else round(coalesce(n.current_market_price, n.median_7d)::numeric, 4)
      end as resolved_market_price,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then coalesce(n.current_market_price_as_of, n.scrydex_as_of)
        when n.justtcg_price is not null and n.justtcg_excluded_reason is null then coalesce(n.current_market_price_as_of, n.justtcg_as_of)
        when n.scrydex_price is not null then coalesce(n.current_market_price_as_of, n.scrydex_as_of)
        when n.justtcg_price is not null then coalesce(n.current_market_price_as_of, n.justtcg_as_of)
        else n.current_market_price_as_of
      end as resolved_market_price_as_of,
      coalesce(greatest(n.justtcg_as_of, n.scrydex_as_of), n.scrydex_as_of, n.justtcg_as_of) as resolved_provider_compare_as_of,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then 'SCRYDEX'
        when n.justtcg_price is not null and n.justtcg_excluded_reason is null then 'JUSTTCG'
        when n.scrydex_price is not null then 'SCRYDEX'
        when n.justtcg_price is not null then 'JUSTTCG'
        else null
      end as selected_provider,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then 'SCRYDEX_PRIMARY'
        when n.justtcg_price is not null and n.justtcg_excluded_reason is null and n.scrydex_price is null then 'SINGLE_PROVIDER'
        when n.justtcg_price is not null and n.justtcg_excluded_reason is null then 'FALLBACK_STALE_OR_OUTLIER'
        when n.scrydex_price is not null or n.justtcg_price is not null then 'FALLBACK_STALE_OR_OUTLIER'
        when coalesce(n.current_market_price, n.median_7d) is not null then 'FALLBACK_STALE_OR_OUTLIER'
        else 'NO_PRICE'
      end as resolved_blend_policy
    from normalized n
  ),
  updates as (
    select
      s.id,
      s.resolved_market_price as market_price,
      s.resolved_market_price_as_of as market_price_as_of,
      s.resolved_provider_compare_as_of as provider_compare_as_of,
      s.confidence_score,
      (
        s.resolved_market_price is null
        or s.confidence_score < 45
        or s.resolved_blend_policy = 'NO_PRICE'
        or s.resolved_blend_policy = 'FALLBACK_STALE_OR_OUTLIER'
        or (s.resolved_blend_policy = 'SINGLE_PROVIDER' and s.selected_provider = 'JUSTTCG')
      ) as low_confidence,
      s.resolved_blend_policy as blend_policy,
      jsonb_build_object(
        'selectedProvider', s.selected_provider,
        'sourceMix', jsonb_build_object(
          'justtcgWeight', round((case when s.w_total > 0 then s.source_mix_justtcg else 0 end)::numeric, 4),
          'scrydexWeight', round((case when s.w_total > 0 then s.source_mix_scrydex else 0 end)::numeric, 4)
        ),
        'providerWeights', jsonb_build_array(
          jsonb_build_object(
            'provider', 'JUSTTCG',
            'weight', round((case when s.w_total > 0 then s.source_mix_justtcg else 0 end)::numeric, 4),
            'trustScore', round((least(1, greatest(0, s.w_justtcg)) * 100)::numeric, 0),
            'freshnessHours', case
              when s.justtcg_as_of is null then null
              else round((extract(epoch from (now() - s.justtcg_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', s.justtcg_points_7d,
            'lastUpdate', s.justtcg_as_of,
            'excludedReason', s.justtcg_excluded_reason
          ),
          jsonb_build_object(
            'provider', 'SCRYDEX',
            'weight', round((case when s.w_total > 0 then s.source_mix_scrydex else 0 end)::numeric, 4),
            'trustScore', round((least(1, greatest(0, s.w_scrydex)) * 100)::numeric, 0),
            'freshnessHours', case
              when s.scrydex_as_of is null then null
              else round((extract(epoch from (now() - s.scrydex_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', s.scrydex_points_7d,
            'lastUpdate', s.scrydex_as_of,
            'excludedReason', s.scrydex_excluded_reason
          )
        ),
        'providerDivergencePct', case
          when s.divergence_pct is null then null
          else round(s.divergence_pct::numeric, 2)
        end,
        'sampleCounts7d', jsonb_build_object(
          'justtcg', s.justtcg_points_7d,
          'scrydex', s.scrydex_points_7d
        ),
        'parityStatus', coalesce(s.parity_status, 'UNKNOWN')
      ) as provenance
    from scored s
  )
  update public.card_metrics cm
  set
    market_price = u.market_price,
    market_price_as_of = u.market_price_as_of,
    provider_compare_as_of = u.provider_compare_as_of,
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
