-- Remove JustTCG from scoped refresh_card_metrics_for_variants.
-- Aligns with the full refresh_card_metrics() (20260315130000) which
-- already excludes JustTCG from price data.  The scoped variant was
-- still reading JUSTTCG rows from price_snapshots and falling back
-- to stale JustTCG prices, inflating market_price_as_of freshness.

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
  v_target_slugs text[];
  v_target_set_count integer := 0;
begin
  if keys is null or jsonb_typeof(keys) <> 'array' or jsonb_array_length(keys) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rows', 0,
      'rowsRemoved', 0,
      'setCount', 0,
      'slugCount', 0
    );
  end if;

  with target_keys as (
    select distinct nullif(trim(item->>'canonical_slug'), '') as canonical_slug
    from jsonb_array_elements(keys) item
    where coalesce(item->>'canonical_slug', '') <> ''
  )
  select
    array_agg(tk.canonical_slug order by tk.canonical_slug),
    count(distinct cc.set_name)::integer
  into v_target_slugs, v_target_set_count
  from target_keys tk
  join public.canonical_cards cc
    on cc.slug = tk.canonical_slug;

  if v_target_slugs is null or coalesce(array_length(v_target_slugs, 1), 0) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rows', 0,
      'rowsRemoved', 0,
      'setCount', 0,
      'slugCount', 0
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
    where ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(v_target_slugs)
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
  provider_latest_by_ref_raw as (
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      'SCRYDEX',
      ps.provider_ref
    )
      ps.id as snapshot_id,
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      'SCRYDEX'::text as provider_key,
      ps.provider_ref,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(v_target_slugs)
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      'SCRYDEX',
      ps.provider_ref,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest_raw as (
    select distinct on (
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key
    )
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key,
      pl.price_value,
      pl.observed_at
    from provider_latest_by_ref_raw pl
    left join public.card_printings cp
      on cp.id = pl.printing_id
    order by
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key,
      public.provider_variant_match_score(
        pl.provider_key,
        pl.provider_ref,
        cp.finish,
        cp.edition,
        cp.stamp
      ) desc,
      pl.observed_at desc,
      pl.snapshot_id desc
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
      null::numeric as justtcg_price,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      null::timestamptz as justtcg_as_of,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_raw
    group by canonical_slug, printing_id, grade
  ),
  canonical_fallback_compare as (
    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      null::numeric as justtcg_price,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      null::timestamptz as justtcg_as_of,
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
      null::numeric as justtcg_price,
      coalesce(pref.scrydex_price, fallback.scrydex_price) as scrydex_price,
      null::timestamptz as justtcg_as_of,
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
    where printing_id is not null
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
    where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '30d')
      and ph.ts >= now() - interval '30 days'
      and ph.canonical_slug = any(v_target_slugs)
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
      null::numeric as justtcg_price,
      pc.scrydex_price,
      pc.scrydex_price as market_price,
      pc.scrydex_as_of as market_price_as_of,
      pc.scrydex_as_of as provider_compare_as_of
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
  ),
  deduped_ranked as (
    select distinct on (r.canonical_slug, r.printing_id, r.grade)
      r.*
    from ranked r
    order by
      r.canonical_slug,
      r.printing_id,
      r.grade,
      r.provider_compare_as_of desc nulls last,
      r.market_price_as_of desc nulls last
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
  from deduped_ranked r
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
      and ps.canonical_slug = any(v_target_slugs)

    union

    select
      ps.canonical_slug,
      null::uuid as printing_id,
      ps.grade
    from public.price_snapshots ps
    where ps.observed_at >= now() - interval '30 days'
      and ps.printing_id is not null
      and ps.canonical_slug = any(v_target_slugs)
  ),
  delete_scope as (
    select cm.id
    from public.card_metrics cm
    where cm.canonical_slug = any(v_target_slugs)
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
    'setCount', v_target_set_count,
    'slugCount', coalesce(array_length(v_target_slugs, 1), 0)
  );
end;
$$;
