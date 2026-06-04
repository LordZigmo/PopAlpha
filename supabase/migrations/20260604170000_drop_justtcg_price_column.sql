-- Drop the retired-provider column public.card_metrics.justtcg_price.
--
-- JustTCG is a retired pricing provider. The justtcg_price column on
-- public.card_metrics is universally NULL and unread by application code.
-- This migration removes the column with ZERO behavioral change to anything
-- else: the dependent functions and views are recreated from their live
-- definitions with ONLY the justtcg_price references stripped out.
--
-- This migration redefines two functions; the function-body guard
-- (scripts/check-migration-function-body.mjs) requires a reference to each
-- one's latest prior definer:
-- supersedes: 20260317093000_phase1_public_live_market_truth_followup.sql  (refresh_card_metrics)
-- supersedes: 20260416230000_fix_scrydex_literal_in_distinct_on.sql        (refresh_card_metrics_for_variants)
--
-- The public.public_card_metrics view body is lifted from its latest definer
-- 20260604150000_blend_pricecharting_change_en_corroborated.sql (minus the
-- 9 justtcg_price projection lines). public.public_jp_price_coverage does not
-- reference justtcg_price; it is recreated verbatim only because it depends on
-- public_card_metrics and must be dropped/recreated around it.
--
-- Statement order: (1) redefine functions so they no longer write the column,
-- (2) drop the dependent views (coverage first, then metrics), (3) recreate the
-- views and re-apply their grants/comments, (4) drop the column.
--
-- The diffs of each recreated object vs. its live definition contain only
-- justtcg line removals. The one non-justtcg-text line removed is the single
-- orphaned `null` value in refresh_card_metrics()'s INSERT ... SELECT that
-- previously fed the now-removed justtcg_price column (required to keep the
-- INSERT column/value counts balanced); the resulting column->value mapping is
-- byte-identical to the original for every surviving column.

-- 1. Recreate the refresh functions without justtcg_price.

CREATE OR REPLACE FUNCTION public.refresh_card_metrics()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '0'
 SET lock_timeout TO '0'
AS $function$
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
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'
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
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.provider_ref
    )
      ps.id as snapshot_id,
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.provider_ref,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '72 hours'
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
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
      pc.scrydex_price,
      pc.scrydex_price as market_price,
      case when pc.scrydex_price is not null then pc.scrydex_as_of else null end as market_price_as_of,
      case when pc.scrydex_price is not null then pc.scrydex_as_of else null end as provider_compare_as_of
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
    r.scrydex_price,
    null,
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
    scrydex_price = excluded.scrydex_price,
    pokemontcg_price = excluded.pokemontcg_price,
    market_price = excluded.market_price,
    market_price_as_of = excluded.market_price_as_of,
    provider_compare_as_of = excluded.provider_compare_as_of,
    updated_at = excluded.updated_at;

  get diagnostics affected = row_count;

  with active_keys as (
    select
      canonical_slug,
      printing_id,
      grade
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'

    union

    select
      canonical_slug,
      null::uuid as printing_id,
      grade
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'
      and printing_id is not null
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
$function$;

CREATE OR REPLACE FUNCTION public.refresh_card_metrics_for_variants(keys jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '0'
 SET lock_timeout TO '0'
 SET search_path TO 'public'
AS $function$
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
      ps.provider,
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
      ps.provider,
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
$function$;

-- 2. Drop the dependent views (coverage depends on metrics, so drop it first).
drop view if exists public.public_jp_price_coverage;
drop view if exists public.public_card_metrics;

-- 3a. Recreate public.public_card_metrics (no justtcg_price column) and re-apply grants.
-- Grant matches the prior definer 20260604150000 (anon, authenticated). service_role
-- retains full access via Supabase's ALTER DEFAULT PRIVILEGES, so it is not re-granted
-- explicitly here (the live per-view service_role privileges come from those defaults,
-- not an object grant, and are reinstated automatically on CREATE).
create view public.public_card_metrics as
 WITH metric_rows AS (
         SELECT base_cm.id,
            base_cm.canonical_slug,
            base_cm.printing_id,
            base_cm.grade,
            base_cm.median_7d,
            base_cm.median_30d,
            base_cm.low_30d,
            base_cm.high_30d,
            base_cm.trimmed_median_30d,
            base_cm.volatility_30d,
            base_cm.liquidity_score,
            base_cm.percentile_rank,
            base_cm.scarcity_adjusted_value,
            base_cm.active_listings_7d,
            base_cm.snapshot_count_30d,
            base_cm.updated_at,
            base_cm.provider_trend_slope_7d,
            base_cm.provider_trend_slope_30d,
            base_cm.provider_cov_price_7d,
            base_cm.provider_cov_price_30d,
            base_cm.provider_price_relative_to_30d_range,
            base_cm.provider_min_price_all_time,
            base_cm.provider_min_price_all_time_date,
            base_cm.provider_max_price_all_time,
            base_cm.provider_max_price_all_time_date,
            base_cm.provider_as_of_ts,
            base_cm.provider_price_changes_count_30d,
            base_cm.signal_trend_strength,
            base_cm.signal_breakout,
            base_cm.signal_value_zone,
            base_cm.signals_as_of_ts,
            base_cm.change_pct_24h,
            base_cm.change_pct_7d,
            base_cm.market_price,
            base_cm.market_price_as_of,
            base_cm.pokemontcg_price,
            base_cm.provider_compare_as_of,
            base_cm.scrydex_price,
            base_cm.market_confidence_score,
            base_cm.market_low_confidence,
            base_cm.market_blend_policy,
            base_cm.market_provenance,
            base_cm.grade_id,
            base_cm.display_price,
            base_cm.display_price_as_of,
            base_cm.display_change_pct_24h,
            base_cm.display_change_pct_7d,
            base_cm.latest_price,
            base_cm.latest_price_as_of,
            base_cm.per_printing_display_refreshed_at,
            base_cm.jp_latest_price,
            base_cm.jp_latest_price_as_of,
            base_cm.jp_display_price,
            base_cm.jp_display_price_as_of,
            base_cm.grade = 'RAW'::text AND base_cm.market_price IS NOT NULL AND COALESCE(base_cm.snapshot_count_30d, 0) >= 5 AND base_cm.market_price > (GREATEST(COALESCE(NULLIF(base_cm.median_7d, 0::numeric), 0::numeric), COALESCE(NULLIF(base_cm.median_30d, 0::numeric), 0::numeric), COALESCE(NULLIF(base_cm.trimmed_median_30d, 0::numeric), 0::numeric), COALESCE(NULLIF(base_cm.low_30d, 0::numeric), 0::numeric), 1::numeric) * 20::numeric) AS raw_market_price_outlier
           FROM card_metrics base_cm
        ), joined_rows AS (
         SELECT cm.id,
            cm.canonical_slug,
            cm.printing_id,
            cm.grade,
            cm.median_7d,
            cm.median_30d,
            cm.low_30d,
            cm.high_30d,
            cm.trimmed_median_30d,
            cm.volatility_30d,
            cm.liquidity_score,
            cm.percentile_rank,
            cm.scarcity_adjusted_value,
            cm.active_listings_7d,
            cm.snapshot_count_30d,
            cm.updated_at,
            cm.provider_trend_slope_7d,
            cm.provider_trend_slope_30d,
            cm.provider_cov_price_7d,
            cm.provider_cov_price_30d,
            cm.provider_price_relative_to_30d_range,
            cm.provider_min_price_all_time,
            cm.provider_min_price_all_time_date,
            cm.provider_max_price_all_time,
            cm.provider_max_price_all_time_date,
            cm.provider_as_of_ts,
            cm.provider_price_changes_count_30d,
            cm.signal_trend_strength,
            cm.signal_breakout,
            cm.signal_value_zone,
            cm.signals_as_of_ts,
            cm.change_pct_24h,
            cm.change_pct_7d,
            cm.market_price,
            cm.market_price_as_of,
            cm.pokemontcg_price,
            cm.provider_compare_as_of,
            cm.scrydex_price,
            cm.market_confidence_score,
            cm.market_low_confidence,
            cm.market_blend_policy,
            cm.market_provenance,
            cm.grade_id,
            cm.display_price,
            cm.display_price_as_of,
            cm.display_change_pct_24h,
            cm.display_change_pct_7d,
            cm.latest_price,
            cm.latest_price_as_of,
            cm.per_printing_display_refreshed_at,
            cm.jp_latest_price,
            cm.jp_latest_price_as_of,
            cm.jp_display_price,
            cm.jp_display_price_as_of,
            cm.raw_market_price_outlier,
            cc.canonical_name_native,
            cc.set_name_native,
            cc.language AS canonical_language,
            cc.language = 'EN'::text AND cm.grade = 'RAW'::text AS is_en_raw,
            ctrp.trust_status AS private_trust_status,
            ctrp.trusted_price_usd AS private_trusted_price_usd,
            ctrp.trusted_price_as_of AS private_trusted_price_as_of,
            ctrp.trusted_price_source AS private_trusted_price_source,
            ctrp.pricecharting_price_usd AS private_guardrail_price_usd,
            ctrp.pricecharting_as_of AS private_guardrail_as_of,
            ctrp.scrydex_price_usd AS private_scrydex_price_usd,
            ctrp.scrydex_as_of AS private_scrydex_as_of,
            ctrp.quarantine_reason AS private_quarantine_reason,
            ctrp.pricecharting_change_pct_24h AS private_pricecharting_change_pct_24h,
            ctrp.pricecharting_change_pct_7d AS private_pricecharting_change_pct_7d,
            COALESCE(yjp_specific.price_usd, yjp_canonical.price_usd) AS yahoo_jp_price_out,
            COALESCE(yjp_specific.price_jpy, yjp_canonical.price_jpy) AS yahoo_jp_price_jpy_out,
            COALESCE(yjp_specific.sample_count, yjp_canonical.sample_count) AS yahoo_jp_sample_count_out,
            COALESCE(yjp_specific.observed_at, yjp_canonical.observed_at) AS yahoo_jp_observed_at_out,
            COALESCE(snk_specific.price_usd, snk_canonical.price_usd) AS snkrdunk_price_out,
            COALESCE(snk_specific.sample_count, snk_canonical.sample_count) AS snkrdunk_sample_count_out,
            COALESCE(snk_specific.observed_at, snk_canonical.observed_at) AS snkrdunk_observed_at_out,
            COALESCE(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) AS snkrdunk_product_code_out,
            COALESCE(snk_specific.price_jpy, snk_canonical.price_jpy) AS snkrdunk_price_jpy_out
           FROM metric_rows cm
             LEFT JOIN yahoo_jp_card_prices yjp_specific ON yjp_specific.canonical_slug = cm.canonical_slug AND yjp_specific.printing_id = cm.printing_id AND yjp_specific.grade = cm.grade
             LEFT JOIN yahoo_jp_card_prices yjp_canonical ON yjp_canonical.canonical_slug = cm.canonical_slug AND yjp_canonical.printing_id IS NULL AND yjp_canonical.grade = cm.grade
             LEFT JOIN snkrdunk_card_prices snk_specific ON snk_specific.canonical_slug = cm.canonical_slug AND snk_specific.printing_id = cm.printing_id AND snk_specific.grade = cm.grade
             LEFT JOIN snkrdunk_card_prices snk_canonical ON snk_canonical.canonical_slug = cm.canonical_slug AND snk_canonical.printing_id IS NULL AND snk_canonical.grade = cm.grade
             LEFT JOIN canonical_cards cc ON cc.slug = cm.canonical_slug
             LEFT JOIN canonical_trusted_raw_prices ctrp ON ctrp.canonical_slug = cm.canonical_slug AND NOT ctrp.printing_id IS DISTINCT FROM cm.printing_id
        ), public_price_policy AS (
         SELECT j.id,
            j.canonical_slug,
            j.printing_id,
            j.grade,
            j.median_7d,
            j.median_30d,
            j.low_30d,
            j.high_30d,
            j.trimmed_median_30d,
            j.volatility_30d,
            j.liquidity_score,
            j.percentile_rank,
            j.scarcity_adjusted_value,
            j.active_listings_7d,
            j.snapshot_count_30d,
            j.updated_at,
            j.provider_trend_slope_7d,
            j.provider_trend_slope_30d,
            j.provider_cov_price_7d,
            j.provider_cov_price_30d,
            j.provider_price_relative_to_30d_range,
            j.provider_min_price_all_time,
            j.provider_min_price_all_time_date,
            j.provider_max_price_all_time,
            j.provider_max_price_all_time_date,
            j.provider_as_of_ts,
            j.provider_price_changes_count_30d,
            j.signal_trend_strength,
            j.signal_breakout,
            j.signal_value_zone,
            j.signals_as_of_ts,
            j.change_pct_24h,
            j.change_pct_7d,
            j.market_price,
            j.market_price_as_of,
            j.pokemontcg_price,
            j.provider_compare_as_of,
            j.scrydex_price,
            j.market_confidence_score,
            j.market_low_confidence,
            j.market_blend_policy,
            j.market_provenance,
            j.grade_id,
            j.display_price,
            j.display_price_as_of,
            j.display_change_pct_24h,
            j.display_change_pct_7d,
            j.latest_price,
            j.latest_price_as_of,
            j.per_printing_display_refreshed_at,
            j.jp_latest_price,
            j.jp_latest_price_as_of,
            j.jp_display_price,
            j.jp_display_price_as_of,
            j.raw_market_price_outlier,
            j.canonical_name_native,
            j.set_name_native,
            j.canonical_language,
            j.is_en_raw,
            j.private_trust_status,
            j.private_trusted_price_usd,
            j.private_trusted_price_as_of,
            j.private_trusted_price_source,
            j.private_guardrail_price_usd,
            j.private_guardrail_as_of,
            j.private_scrydex_price_usd,
            j.private_scrydex_as_of,
            j.private_quarantine_reason,
            j.private_pricecharting_change_pct_24h,
            j.private_pricecharting_change_pct_7d,
            j.yahoo_jp_price_out,
            j.yahoo_jp_price_jpy_out,
            j.yahoo_jp_sample_count_out,
            j.yahoo_jp_observed_at_out,
            j.snkrdunk_price_out,
            j.snkrdunk_sample_count_out,
            j.snkrdunk_observed_at_out,
            j.snkrdunk_product_code_out,
            j.snkrdunk_price_jpy_out,
                CASE
                    WHEN j.is_en_raw THEN
                    CASE
                        WHEN j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN COALESCE(j.display_price, j.private_trusted_price_usd)
                        WHEN j.private_trust_status = ANY (ARRAY['PRICECHARTING_PRIMARY'::text, 'PRICECHARTING_DIVERGED'::text, 'NO_TRUSTED_PRICE'::text]) THEN NULL::numeric
                        WHEN j.raw_market_price_outlier THEN NULL::numeric
                        WHEN j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'::text THEN COALESCE(j.display_price, j.private_scrydex_price_usd, j.market_price)
                        ELSE COALESCE(j.display_price, j.market_price)
                    END
                    WHEN j.grade <> 'RAW'::text THEN COALESCE(j.display_price, j.market_price)
                    WHEN j.canonical_language = 'JP'::text AND j.grade = 'RAW'::text THEN j.jp_display_price
                    WHEN j.raw_market_price_outlier THEN NULL::numeric
                    ELSE j.market_price
                END AS public_market_price,
                CASE
                    WHEN j.is_en_raw THEN
                    CASE
                        WHEN j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN
                        CASE
                            WHEN j.display_price IS NOT NULL THEN j.display_price_as_of
                            ELSE COALESCE(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                        END
                        WHEN j.private_trust_status = ANY (ARRAY['PRICECHARTING_PRIMARY'::text, 'PRICECHARTING_DIVERGED'::text, 'NO_TRUSTED_PRICE'::text]) THEN NULL::timestamp with time zone
                        WHEN j.raw_market_price_outlier THEN NULL::timestamp with time zone
                        WHEN j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'::text THEN
                        CASE
                            WHEN j.display_price IS NOT NULL THEN j.display_price_as_of
                            ELSE COALESCE(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.market_price_as_of)
                        END
                        ELSE
                        CASE
                            WHEN j.display_price IS NOT NULL THEN j.display_price_as_of
                            ELSE j.market_price_as_of
                        END
                    END
                    WHEN j.grade <> 'RAW'::text THEN
                    CASE
                        WHEN j.display_price IS NOT NULL THEN j.display_price_as_of
                        ELSE j.market_price_as_of
                    END
                    WHEN j.canonical_language = 'JP'::text AND j.grade = 'RAW'::text THEN j.jp_display_price_as_of
                    WHEN j.raw_market_price_outlier THEN NULL::timestamp with time zone
                    ELSE j.market_price_as_of
                END AS public_market_price_as_of,
                CASE
                    WHEN j.is_en_raw THEN
                    CASE
                        WHEN j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN COALESCE(j.private_scrydex_as_of, j.provider_compare_as_of)
                        WHEN j.private_trust_status = ANY (ARRAY['PRICECHARTING_PRIMARY'::text, 'PRICECHARTING_DIVERGED'::text, 'NO_TRUSTED_PRICE'::text]) THEN NULL::timestamp with time zone
                        WHEN j.raw_market_price_outlier THEN NULL::timestamp with time zone
                        WHEN j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'::text THEN COALESCE(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.provider_compare_as_of)
                        ELSE j.provider_compare_as_of
                    END
                    WHEN j.raw_market_price_outlier THEN NULL::timestamp with time zone
                    ELSE j.provider_compare_as_of
                END AS public_provider_compare_as_of
           FROM joined_rows j
        ), public_signal_policy AS (
         SELECT p.id,
            p.canonical_slug,
            p.printing_id,
            p.grade,
            p.median_7d,
            p.median_30d,
            p.low_30d,
            p.high_30d,
            p.trimmed_median_30d,
            p.volatility_30d,
            p.liquidity_score,
            p.percentile_rank,
            p.scarcity_adjusted_value,
            p.active_listings_7d,
            p.snapshot_count_30d,
            p.updated_at,
            p.provider_trend_slope_7d,
            p.provider_trend_slope_30d,
            p.provider_cov_price_7d,
            p.provider_cov_price_30d,
            p.provider_price_relative_to_30d_range,
            p.provider_min_price_all_time,
            p.provider_min_price_all_time_date,
            p.provider_max_price_all_time,
            p.provider_max_price_all_time_date,
            p.provider_as_of_ts,
            p.provider_price_changes_count_30d,
            p.signal_trend_strength,
            p.signal_breakout,
            p.signal_value_zone,
            p.signals_as_of_ts,
            p.change_pct_24h,
            p.change_pct_7d,
            p.market_price,
            p.market_price_as_of,
            p.pokemontcg_price,
            p.provider_compare_as_of,
            p.scrydex_price,
            p.market_confidence_score,
            p.market_low_confidence,
            p.market_blend_policy,
            p.market_provenance,
            p.grade_id,
            p.display_price,
            p.display_price_as_of,
            p.display_change_pct_24h,
            p.display_change_pct_7d,
            p.latest_price,
            p.latest_price_as_of,
            p.per_printing_display_refreshed_at,
            p.jp_latest_price,
            p.jp_latest_price_as_of,
            p.jp_display_price,
            p.jp_display_price_as_of,
            p.raw_market_price_outlier,
            p.canonical_name_native,
            p.set_name_native,
            p.canonical_language,
            p.is_en_raw,
            p.private_trust_status,
            p.private_trusted_price_usd,
            p.private_trusted_price_as_of,
            p.private_trusted_price_source,
            p.private_guardrail_price_usd,
            p.private_guardrail_as_of,
            p.private_scrydex_price_usd,
            p.private_scrydex_as_of,
            p.private_quarantine_reason,
            p.private_pricecharting_change_pct_24h,
            p.private_pricecharting_change_pct_7d,
            p.yahoo_jp_price_out,
            p.yahoo_jp_price_jpy_out,
            p.yahoo_jp_sample_count_out,
            p.yahoo_jp_observed_at_out,
            p.snkrdunk_price_out,
            p.snkrdunk_sample_count_out,
            p.snkrdunk_observed_at_out,
            p.snkrdunk_product_code_out,
            p.snkrdunk_price_jpy_out,
            p.public_market_price,
            p.public_market_price_as_of,
            p.public_provider_compare_as_of,
                CASE
                    WHEN p.public_market_price IS NULL THEN NULL::numeric
                    WHEN p.is_en_raw THEN COALESCE(p.latest_price, p.public_market_price)
                    WHEN p.grade <> 'RAW'::text THEN COALESCE(p.latest_price, p.public_market_price)
                    WHEN p.canonical_language = 'JP'::text AND p.grade = 'RAW'::text THEN COALESCE(p.jp_latest_price, p.public_market_price)
                    ELSE p.public_market_price
                END AS public_latest_price,
                CASE
                    WHEN p.public_market_price IS NULL THEN NULL::timestamp with time zone
                    WHEN p.is_en_raw THEN COALESCE(p.latest_price_as_of, p.public_market_price_as_of)
                    WHEN p.grade <> 'RAW'::text THEN COALESCE(p.latest_price_as_of, p.public_market_price_as_of)
                    WHEN p.canonical_language = 'JP'::text AND p.grade = 'RAW'::text THEN COALESCE(p.jp_latest_price_as_of, p.public_market_price_as_of)
                    ELSE p.public_market_price_as_of
                END AS public_latest_price_as_of,
                CASE
                    WHEN p.is_en_raw THEN
                    CASE
                        WHEN p.public_market_price IS NULL THEN NULL::numeric
                        WHEN p.display_price IS NOT NULL AND p.display_change_pct_24h IS NOT NULL THEN p.display_change_pct_24h
                        WHEN p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN COALESCE(p.change_pct_24h,
                        CASE
                            WHEN abs(p.private_pricecharting_change_pct_24h) <= 200::numeric AND p.private_guardrail_as_of >= (now() - '48:00:00'::interval) THEN p.private_pricecharting_change_pct_24h
                            ELSE NULL::numeric
                        END)
                        ELSE NULL::numeric
                    END
                    WHEN p.raw_market_price_outlier THEN NULL::numeric
                    ELSE p.change_pct_24h
                END AS public_change_pct_24h,
                CASE
                    WHEN p.is_en_raw THEN
                    CASE
                        WHEN p.public_market_price IS NULL THEN NULL::numeric
                        WHEN p.display_price IS NOT NULL AND p.display_change_pct_7d IS NOT NULL THEN p.display_change_pct_7d
                        WHEN p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN COALESCE(p.change_pct_7d,
                        CASE
                            WHEN abs(p.private_pricecharting_change_pct_7d) <= 200::numeric AND p.private_guardrail_as_of >= (now() - '48:00:00'::interval) THEN p.private_pricecharting_change_pct_7d
                            ELSE NULL::numeric
                        END)
                        ELSE NULL::numeric
                    END
                    WHEN p.raw_market_price_outlier THEN NULL::numeric
                    ELSE p.change_pct_7d
                END AS public_change_pct_7d,
                CASE
                    WHEN p.is_en_raw THEN
                    CASE
                        WHEN p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text AND p.public_market_price IS NOT NULL THEN 90::numeric
                        WHEN p.private_trust_status = ANY (ARRAY['PRICECHARTING_PRIMARY'::text, 'PRICECHARTING_DIVERGED'::text, 'NO_TRUSTED_PRICE'::text]) THEN 0::numeric
                        WHEN p.raw_market_price_outlier THEN 0::numeric
                        WHEN p.public_market_price IS NOT NULL THEN LEAST(COALESCE(p.market_confidence_score, 25::numeric), 35::numeric)
                        ELSE 0::numeric
                    END
                    WHEN p.raw_market_price_outlier THEN 0::numeric
                    ELSE p.market_confidence_score
                END AS public_confidence_score,
                CASE
                    WHEN p.is_en_raw THEN
                    CASE
                        WHEN p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text AND p.public_market_price IS NOT NULL THEN false
                        ELSE true
                    END
                    WHEN p.raw_market_price_outlier THEN true
                    ELSE p.market_low_confidence
                END AS public_low_confidence,
                CASE
                    WHEN p.is_en_raw THEN
                    CASE
                        WHEN p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text AND p.public_market_price IS NOT NULL THEN 'POPALPHA_MARKET_CONFIDENT'::text
                        WHEN p.private_trust_status = 'PRICECHARTING_DIVERGED'::text THEN 'POPALPHA_MARKET_QUARANTINED'::text
                        WHEN p.private_trust_status = 'PRICECHARTING_PRIMARY'::text THEN 'NO_RELIABLE_PRICE'::text
                        WHEN p.raw_market_price_outlier THEN 'OUTLIER_SUPPRESSED'::text
                        WHEN p.public_market_price IS NOT NULL THEN 'POPALPHA_MARKET_LOW_CONFIDENCE'::text
                        ELSE 'NO_RELIABLE_PRICE'::text
                    END
                    WHEN p.raw_market_price_outlier THEN 'OUTLIER_SUPPRESSED'::text
                    ELSE p.market_blend_policy
                END AS public_market_blend_policy
           FROM public_price_policy p
        ), public_signal_context AS (
         SELECT s.id,
            s.canonical_slug,
            s.printing_id,
            s.grade,
            s.median_7d,
            s.median_30d,
            s.low_30d,
            s.high_30d,
            s.trimmed_median_30d,
            s.volatility_30d,
            s.liquidity_score,
            s.percentile_rank,
            s.scarcity_adjusted_value,
            s.active_listings_7d,
            s.snapshot_count_30d,
            s.updated_at,
            s.provider_trend_slope_7d,
            s.provider_trend_slope_30d,
            s.provider_cov_price_7d,
            s.provider_cov_price_30d,
            s.provider_price_relative_to_30d_range,
            s.provider_min_price_all_time,
            s.provider_min_price_all_time_date,
            s.provider_max_price_all_time,
            s.provider_max_price_all_time_date,
            s.provider_as_of_ts,
            s.provider_price_changes_count_30d,
            s.signal_trend_strength,
            s.signal_breakout,
            s.signal_value_zone,
            s.signals_as_of_ts,
            s.change_pct_24h,
            s.change_pct_7d,
            s.market_price,
            s.market_price_as_of,
            s.pokemontcg_price,
            s.provider_compare_as_of,
            s.scrydex_price,
            s.market_confidence_score,
            s.market_low_confidence,
            s.market_blend_policy,
            s.market_provenance,
            s.grade_id,
            s.display_price,
            s.display_price_as_of,
            s.display_change_pct_24h,
            s.display_change_pct_7d,
            s.latest_price,
            s.latest_price_as_of,
            s.per_printing_display_refreshed_at,
            s.jp_latest_price,
            s.jp_latest_price_as_of,
            s.jp_display_price,
            s.jp_display_price_as_of,
            s.raw_market_price_outlier,
            s.canonical_name_native,
            s.set_name_native,
            s.canonical_language,
            s.is_en_raw,
            s.private_trust_status,
            s.private_trusted_price_usd,
            s.private_trusted_price_as_of,
            s.private_trusted_price_source,
            s.private_guardrail_price_usd,
            s.private_guardrail_as_of,
            s.private_scrydex_price_usd,
            s.private_scrydex_as_of,
            s.private_quarantine_reason,
            s.private_pricecharting_change_pct_24h,
            s.private_pricecharting_change_pct_7d,
            s.yahoo_jp_price_out,
            s.yahoo_jp_price_jpy_out,
            s.yahoo_jp_sample_count_out,
            s.yahoo_jp_observed_at_out,
            s.snkrdunk_price_out,
            s.snkrdunk_sample_count_out,
            s.snkrdunk_observed_at_out,
            s.snkrdunk_product_code_out,
            s.snkrdunk_price_jpy_out,
            s.public_market_price,
            s.public_market_price_as_of,
            s.public_provider_compare_as_of,
            s.public_latest_price,
            s.public_latest_price_as_of,
            s.public_change_pct_24h,
            s.public_change_pct_7d,
            s.public_confidence_score,
            s.public_low_confidence,
            s.public_market_blend_policy,
                CASE
                    WHEN s.is_en_raw AND s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text AND s.public_market_price IS NOT NULL AND s.private_scrydex_price_usd IS NOT NULL THEN s.private_scrydex_price_usd
                    ELSE NULL::numeric
                END AS recent_market_signal_usd,
                CASE
                    WHEN s.is_en_raw AND s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text AND s.public_market_price IS NOT NULL AND s.private_scrydex_price_usd IS NOT NULL THEN s.private_scrydex_as_of
                    ELSE NULL::timestamp with time zone
                END AS recent_market_signal_as_of
           FROM public_signal_policy s
        ), public_signal_gap AS (
         SELECT c.id,
            c.canonical_slug,
            c.printing_id,
            c.grade,
            c.median_7d,
            c.median_30d,
            c.low_30d,
            c.high_30d,
            c.trimmed_median_30d,
            c.volatility_30d,
            c.liquidity_score,
            c.percentile_rank,
            c.scarcity_adjusted_value,
            c.active_listings_7d,
            c.snapshot_count_30d,
            c.updated_at,
            c.provider_trend_slope_7d,
            c.provider_trend_slope_30d,
            c.provider_cov_price_7d,
            c.provider_cov_price_30d,
            c.provider_price_relative_to_30d_range,
            c.provider_min_price_all_time,
            c.provider_min_price_all_time_date,
            c.provider_max_price_all_time,
            c.provider_max_price_all_time_date,
            c.provider_as_of_ts,
            c.provider_price_changes_count_30d,
            c.signal_trend_strength,
            c.signal_breakout,
            c.signal_value_zone,
            c.signals_as_of_ts,
            c.change_pct_24h,
            c.change_pct_7d,
            c.market_price,
            c.market_price_as_of,
            c.pokemontcg_price,
            c.provider_compare_as_of,
            c.scrydex_price,
            c.market_confidence_score,
            c.market_low_confidence,
            c.market_blend_policy,
            c.market_provenance,
            c.grade_id,
            c.display_price,
            c.display_price_as_of,
            c.display_change_pct_24h,
            c.display_change_pct_7d,
            c.latest_price,
            c.latest_price_as_of,
            c.per_printing_display_refreshed_at,
            c.jp_latest_price,
            c.jp_latest_price_as_of,
            c.jp_display_price,
            c.jp_display_price_as_of,
            c.raw_market_price_outlier,
            c.canonical_name_native,
            c.set_name_native,
            c.canonical_language,
            c.is_en_raw,
            c.private_trust_status,
            c.private_trusted_price_usd,
            c.private_trusted_price_as_of,
            c.private_trusted_price_source,
            c.private_guardrail_price_usd,
            c.private_guardrail_as_of,
            c.private_scrydex_price_usd,
            c.private_scrydex_as_of,
            c.private_quarantine_reason,
            c.private_pricecharting_change_pct_24h,
            c.private_pricecharting_change_pct_7d,
            c.yahoo_jp_price_out,
            c.yahoo_jp_price_jpy_out,
            c.yahoo_jp_sample_count_out,
            c.yahoo_jp_observed_at_out,
            c.snkrdunk_price_out,
            c.snkrdunk_sample_count_out,
            c.snkrdunk_observed_at_out,
            c.snkrdunk_product_code_out,
            c.snkrdunk_price_jpy_out,
            c.public_market_price,
            c.public_market_price_as_of,
            c.public_provider_compare_as_of,
            c.public_latest_price,
            c.public_latest_price_as_of,
            c.public_change_pct_24h,
            c.public_change_pct_7d,
            c.public_confidence_score,
            c.public_low_confidence,
            c.public_market_blend_policy,
            c.recent_market_signal_usd,
            c.recent_market_signal_as_of,
                CASE
                    WHEN c.recent_market_signal_usd IS NOT NULL AND c.public_market_price IS NOT NULL AND c.public_market_price > 0::numeric THEN round((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price * 100::numeric, 2)
                    ELSE NULL::numeric
                END AS recent_market_signal_delta_pct,
                CASE
                    WHEN c.recent_market_signal_usd IS NOT NULL AND c.public_market_price IS NOT NULL AND c.public_market_price > 0::numeric AND abs(c.recent_market_signal_usd - c.public_market_price) >=
                    CASE
                        WHEN c.public_market_price < 25::numeric THEN 1
                        WHEN c.public_market_price < 100::numeric THEN 5
                        WHEN c.public_market_price < 500::numeric THEN 25
                        ELSE 50
                    END::numeric AND abs((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price * 100::numeric) >=
                    CASE
                        WHEN c.public_market_price < 25::numeric THEN 20
                        WHEN c.public_market_price < 100::numeric THEN 15
                        WHEN c.public_market_price < 500::numeric THEN 10
                        ELSE 8
                    END::numeric AND c.recent_market_signal_usd > c.public_market_price THEN 'HIGHER'::text
                    WHEN c.recent_market_signal_usd IS NOT NULL AND c.public_market_price IS NOT NULL AND c.public_market_price > 0::numeric AND abs(c.recent_market_signal_usd - c.public_market_price) >=
                    CASE
                        WHEN c.public_market_price < 25::numeric THEN 1
                        WHEN c.public_market_price < 100::numeric THEN 5
                        WHEN c.public_market_price < 500::numeric THEN 25
                        ELSE 50
                    END::numeric AND abs((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price * 100::numeric) >=
                    CASE
                        WHEN c.public_market_price < 25::numeric THEN 20
                        WHEN c.public_market_price < 100::numeric THEN 15
                        WHEN c.public_market_price < 500::numeric THEN 10
                        ELSE 8
                    END::numeric AND c.recent_market_signal_usd < c.public_market_price THEN 'LOWER'::text
                    ELSE NULL::text
                END AS recent_market_signal_direction
           FROM public_signal_context c
        ), public_display_policy AS (
         SELECT g.id,
            g.canonical_slug,
            g.printing_id,
            g.grade,
            g.median_7d,
            g.median_30d,
            g.low_30d,
            g.high_30d,
            g.trimmed_median_30d,
            g.volatility_30d,
            g.liquidity_score,
            g.percentile_rank,
            g.scarcity_adjusted_value,
            g.active_listings_7d,
            g.snapshot_count_30d,
            g.updated_at,
            g.provider_trend_slope_7d,
            g.provider_trend_slope_30d,
            g.provider_cov_price_7d,
            g.provider_cov_price_30d,
            g.provider_price_relative_to_30d_range,
            g.provider_min_price_all_time,
            g.provider_min_price_all_time_date,
            g.provider_max_price_all_time,
            g.provider_max_price_all_time_date,
            g.provider_as_of_ts,
            g.provider_price_changes_count_30d,
            g.signal_trend_strength,
            g.signal_breakout,
            g.signal_value_zone,
            g.signals_as_of_ts,
            g.change_pct_24h,
            g.change_pct_7d,
            g.market_price,
            g.market_price_as_of,
            g.pokemontcg_price,
            g.provider_compare_as_of,
            g.scrydex_price,
            g.market_confidence_score,
            g.market_low_confidence,
            g.market_blend_policy,
            g.market_provenance,
            g.grade_id,
            g.display_price,
            g.display_price_as_of,
            g.display_change_pct_24h,
            g.display_change_pct_7d,
            g.latest_price,
            g.latest_price_as_of,
            g.per_printing_display_refreshed_at,
            g.jp_latest_price,
            g.jp_latest_price_as_of,
            g.jp_display_price,
            g.jp_display_price_as_of,
            g.raw_market_price_outlier,
            g.canonical_name_native,
            g.set_name_native,
            g.canonical_language,
            g.is_en_raw,
            g.private_trust_status,
            g.private_trusted_price_usd,
            g.private_trusted_price_as_of,
            g.private_trusted_price_source,
            g.private_guardrail_price_usd,
            g.private_guardrail_as_of,
            g.private_scrydex_price_usd,
            g.private_scrydex_as_of,
            g.private_quarantine_reason,
            g.private_pricecharting_change_pct_24h,
            g.private_pricecharting_change_pct_7d,
            g.yahoo_jp_price_out,
            g.yahoo_jp_price_jpy_out,
            g.yahoo_jp_sample_count_out,
            g.yahoo_jp_observed_at_out,
            g.snkrdunk_price_out,
            g.snkrdunk_sample_count_out,
            g.snkrdunk_observed_at_out,
            g.snkrdunk_product_code_out,
            g.snkrdunk_price_jpy_out,
            g.public_market_price,
            g.public_market_price_as_of,
            g.public_provider_compare_as_of,
            g.public_latest_price,
            g.public_latest_price_as_of,
            g.public_change_pct_24h,
            g.public_change_pct_7d,
            g.public_confidence_score,
            g.public_low_confidence,
            g.public_market_blend_policy,
            g.recent_market_signal_usd,
            g.recent_market_signal_as_of,
            g.recent_market_signal_delta_pct,
            g.recent_market_signal_direction,
                CASE
                    WHEN g.is_en_raw AND (g.private_trust_status = 'PRICECHARTING_DIVERGED'::text OR g.raw_market_price_outlier) AND g.public_market_price IS NULL THEN 'UNDER_REVIEW'::text
                    WHEN g.public_market_price IS NULL THEN 'NO_RELIABLE_PRICE'::text
                    WHEN g.is_en_raw AND g.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'::text THEN 'PUBLIC_ONLY'::text
                    WHEN g.recent_market_signal_direction = 'HIGHER'::text THEN 'SIGNAL_HIGHER'::text
                    WHEN g.recent_market_signal_direction = 'LOWER'::text THEN 'SIGNAL_LOWER'::text
                    ELSE 'ALIGNED'::text
                END AS market_price_display_state
           FROM public_signal_gap g
        ), public_provenance_policy AS (
         SELECT s.id,
            s.canonical_slug,
            s.printing_id,
            s.grade,
            s.median_7d,
            s.median_30d,
            s.low_30d,
            s.high_30d,
            s.trimmed_median_30d,
            s.volatility_30d,
            s.liquidity_score,
            s.percentile_rank,
            s.scarcity_adjusted_value,
            s.active_listings_7d,
            s.snapshot_count_30d,
            s.updated_at,
            s.provider_trend_slope_7d,
            s.provider_trend_slope_30d,
            s.provider_cov_price_7d,
            s.provider_cov_price_30d,
            s.provider_price_relative_to_30d_range,
            s.provider_min_price_all_time,
            s.provider_min_price_all_time_date,
            s.provider_max_price_all_time,
            s.provider_max_price_all_time_date,
            s.provider_as_of_ts,
            s.provider_price_changes_count_30d,
            s.signal_trend_strength,
            s.signal_breakout,
            s.signal_value_zone,
            s.signals_as_of_ts,
            s.change_pct_24h,
            s.change_pct_7d,
            s.market_price,
            s.market_price_as_of,
            s.pokemontcg_price,
            s.provider_compare_as_of,
            s.scrydex_price,
            s.market_confidence_score,
            s.market_low_confidence,
            s.market_blend_policy,
            s.market_provenance,
            s.grade_id,
            s.display_price,
            s.display_price_as_of,
            s.display_change_pct_24h,
            s.display_change_pct_7d,
            s.latest_price,
            s.latest_price_as_of,
            s.per_printing_display_refreshed_at,
            s.jp_latest_price,
            s.jp_latest_price_as_of,
            s.jp_display_price,
            s.jp_display_price_as_of,
            s.raw_market_price_outlier,
            s.canonical_name_native,
            s.set_name_native,
            s.canonical_language,
            s.is_en_raw,
            s.private_trust_status,
            s.private_trusted_price_usd,
            s.private_trusted_price_as_of,
            s.private_trusted_price_source,
            s.private_guardrail_price_usd,
            s.private_guardrail_as_of,
            s.private_scrydex_price_usd,
            s.private_scrydex_as_of,
            s.private_quarantine_reason,
            s.private_pricecharting_change_pct_24h,
            s.private_pricecharting_change_pct_7d,
            s.yahoo_jp_price_out,
            s.yahoo_jp_price_jpy_out,
            s.yahoo_jp_sample_count_out,
            s.yahoo_jp_observed_at_out,
            s.snkrdunk_price_out,
            s.snkrdunk_sample_count_out,
            s.snkrdunk_observed_at_out,
            s.snkrdunk_product_code_out,
            s.snkrdunk_price_jpy_out,
            s.public_market_price,
            s.public_market_price_as_of,
            s.public_provider_compare_as_of,
            s.public_latest_price,
            s.public_latest_price_as_of,
            s.public_change_pct_24h,
            s.public_change_pct_7d,
            s.public_confidence_score,
            s.public_low_confidence,
            s.public_market_blend_policy,
            s.recent_market_signal_usd,
            s.recent_market_signal_as_of,
            s.recent_market_signal_delta_pct,
            s.recent_market_signal_direction,
            s.market_price_display_state,
                CASE
                    WHEN s.is_en_raw THEN jsonb_strip_nulls(jsonb_build_object('marketPriceLabel', 'PopAlpha Market Price', 'marketPriceDisplayState', s.market_price_display_state, 'recentMarketSignalDirection', s.recent_market_signal_direction, 'recentMarketSignalDeltaPct', s.recent_market_signal_delta_pct, 'confidenceStatus',
                    CASE
                        WHEN s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text AND s.public_market_price IS NOT NULL THEN 'HIGH'::text
                        WHEN s.private_trust_status = 'PRICECHARTING_DIVERGED'::text THEN 'QUARANTINED'::text
                        WHEN s.public_market_price IS NOT NULL THEN 'LOW'::text
                        ELSE 'NONE'::text
                    END, 'publicInputStatus',
                    CASE
                        WHEN s.private_trust_status = 'PRICECHARTING_DIVERGED'::text THEN 'QUARANTINED'::text
                        WHEN s.private_trust_status = 'PRICECHARTING_PRIMARY'::text THEN 'INSUFFICIENT_PUBLIC_INPUT'::text
                        WHEN s.public_market_price IS NOT NULL THEN 'SUPPORTED'::text
                        ELSE 'INSUFFICIENT_PUBLIC_INPUT'::text
                    END, 'priceConflictStatus',
                    CASE
                        WHEN s.private_trust_status = 'PRICECHARTING_DIVERGED'::text THEN 'INTERNAL_GUARDRAIL_DIVERGED'::text
                        WHEN s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN 'CONSISTENT'::text
                        WHEN s.public_market_price IS NOT NULL THEN 'PUBLIC_INPUT_ONLY'::text
                        ELSE 'NONE'::text
                    END, 'internalGuardrailStatus',
                    CASE
                        WHEN s.private_trust_status = 'PRICECHARTING_DIVERGED'::text THEN 'DIVERGED'::text
                        WHEN s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN 'CONSISTENT'::text
                        WHEN s.private_trust_status = 'PRICECHARTING_PRIMARY'::text THEN 'PRIVATE_ONLY'::text
                        ELSE 'NOT_AVAILABLE'::text
                    END, 'priceAsOf', s.public_market_price_as_of, 'movementHistorySource',
                    CASE
                        WHEN s.public_market_price IS NOT NULL AND (s.public_change_pct_24h IS NOT NULL OR s.public_change_pct_7d IS NOT NULL) THEN 'PERMITTED_MARKET_INPUT'::text
                        ELSE NULL::text
                    END, 'quarantineReason',
                    CASE
                        WHEN s.private_trust_status = 'PRICECHARTING_DIVERGED'::text THEN 'PUBLIC_INPUT_DIVERGED_FROM_INTERNAL_GUARDRAIL'::text
                        WHEN s.private_trust_status = 'PRICECHARTING_PRIMARY'::text THEN 'MISSING_PERMITTED_PUBLIC_INPUT'::text
                        WHEN s.raw_market_price_outlier AND s.public_market_price IS NULL THEN 'PUBLIC_INPUT_OUTLIER_SUPPRESSED'::text
                        ELSE NULL::text
                    END, 'parityStatus',
                    CASE
                        WHEN s.public_market_price IS NOT NULL AND (s.public_change_pct_24h IS NOT NULL OR s.public_change_pct_7d IS NOT NULL) AND s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'::text THEN 'MATCH'::text
                        ELSE 'MISSING_PROVIDER'::text
                    END, 'sourceMix', jsonb_build_object('scrydexWeight',
                    CASE
                        WHEN s.public_market_price IS NOT NULL THEN 1
                        ELSE 0
                    END, 'publicInputWeight',
                    CASE
                        WHEN s.public_market_price IS NOT NULL THEN 1
                        ELSE 0
                    END), 'sampleCounts7d', jsonb_build_object('scrydex',
                    CASE
                        WHEN COALESCE((s.market_provenance -> 'sampleCounts7d'::text) ->> 'scrydex'::text, ''::text) ~ '^[0-9]+$'::text THEN ((s.market_provenance -> 'sampleCounts7d'::text) ->> 'scrydex'::text)::integer
                        ELSE 0
                    END, 'public',
                    CASE
                        WHEN s.public_market_price IS NOT NULL AND COALESCE((s.market_provenance -> 'sampleCounts7d'::text) ->> 'scrydex'::text, ''::text) ~ '^[0-9]+$'::text THEN ((s.market_provenance -> 'sampleCounts7d'::text) ->> 'scrydex'::text)::integer
                        ELSE 0
                    END)))
                    WHEN s.raw_market_price_outlier THEN COALESCE(s.market_provenance, '{}'::jsonb) || jsonb_build_object('parityStatus', 'MISSING_PROVIDER')
                    ELSE s.market_provenance
                END AS public_market_provenance
           FROM public_display_policy s
        )
 SELECT id,
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
    provider_trend_slope_7d,
    provider_trend_slope_30d,
    provider_cov_price_7d,
    provider_cov_price_30d,
    provider_price_relative_to_30d_range,
    provider_min_price_all_time,
    provider_min_price_all_time_date,
    provider_max_price_all_time,
    provider_max_price_all_time_date,
    provider_as_of_ts,
    provider_price_changes_count_30d,
        CASE
            WHEN is_en_raw AND public_market_price IS NULL THEN NULL::numeric
            WHEN raw_market_price_outlier THEN NULL::numeric
            ELSE COALESCE(recent_market_signal_usd, scrydex_price)
        END AS scrydex_price,
        CASE
            WHEN is_en_raw AND public_market_price IS NULL THEN NULL::numeric
            WHEN raw_market_price_outlier THEN NULL::numeric
            ELSE COALESCE(recent_market_signal_usd, scrydex_price)
        END AS pokemontcg_price,
    yahoo_jp_price_out AS yahoo_jp_price,
    yahoo_jp_price_jpy_out AS yahoo_jp_price_jpy,
    yahoo_jp_sample_count_out AS yahoo_jp_sample_count,
    yahoo_jp_observed_at_out AS yahoo_jp_observed_at,
    snkrdunk_price_out AS snkrdunk_price,
    snkrdunk_sample_count_out AS snkrdunk_sample_count,
    snkrdunk_observed_at_out AS snkrdunk_observed_at,
    snkrdunk_product_code_out AS snkrdunk_product_code,
    public_market_price AS market_price,
    public_market_price_as_of AS market_price_as_of,
    public_provider_compare_as_of AS provider_compare_as_of,
    public_confidence_score AS market_confidence_score,
    public_low_confidence AS market_low_confidence,
    public_market_blend_policy AS market_blend_policy,
    public_market_provenance AS market_provenance,
    public_change_pct_24h AS change_pct_24h,
    public_change_pct_7d AS change_pct_7d,
    updated_at,
    canonical_name_native,
    set_name_native,
    canonical_language AS language,
    snkrdunk_price_jpy_out AS snkrdunk_price_jpy,
    market_price_display_state,
    recent_market_signal_usd,
    recent_market_signal_as_of,
    recent_market_signal_delta_pct,
    recent_market_signal_direction,
    public_latest_price AS latest_price,
    public_latest_price_as_of AS latest_price_as_of,
    jp_latest_price,
    jp_latest_price_as_of,
    jp_display_price,
    jp_display_price_as_of
   FROM public_provenance_policy;

grant select on public.public_card_metrics to anon, authenticated;

-- 3b. Recreate public.public_jp_price_coverage verbatim and re-apply grants + comment.
create view public.public_jp_price_coverage as
 WITH base AS (
         SELECT cc.slug AS canonical_slug,
            cc.canonical_name,
            cc.set_name,
            cc.year,
            cc.card_number,
            cc.primary_image_url,
            cc.mirrored_primary_image_url,
            cc.mirrored_primary_thumb_url,
            'RAW'::text AS grade,
            pcm.market_price,
            pcm.market_price_as_of,
            pcm.market_confidence_score,
            pcm.market_low_confidence,
            pcm.active_listings_7d,
            pcm.snapshot_count_30d,
            pcm.change_pct_24h,
            pcm.change_pct_7d,
            pcm.jp_latest_price,
            pcm.jp_latest_price_as_of,
            yjp.price_usd AS yahoo_jp_price,
            yjp.price_jpy AS yahoo_jp_price_jpy,
            yjp.sample_count AS yahoo_jp_sample_count,
            yjp.observed_at AS yahoo_jp_observed_at,
            snk.price_usd AS snkrdunk_price,
            snk.price_jpy AS snkrdunk_price_jpy,
            snk.sample_count AS snkrdunk_sample_count,
            snk.observed_at AS snkrdunk_observed_at,
            snk.snkrdunk_product_code
           FROM canonical_cards cc
             LEFT JOIN public_card_metrics pcm ON pcm.canonical_slug = cc.slug AND pcm.printing_id IS NULL AND pcm.grade = 'RAW'::text
             LEFT JOIN yahoo_jp_card_prices yjp ON yjp.canonical_slug = cc.slug AND yjp.printing_id IS NULL AND yjp.grade = 'RAW'::text
             LEFT JOIN snkrdunk_card_prices snk ON snk.canonical_slug = cc.slug AND snk.printing_id IS NULL AND snk.grade = 'RAW'::text
          WHERE cc.language = 'JP'::text
        ), qualified AS (
         SELECT base.canonical_slug,
            base.canonical_name,
            base.set_name,
            base.year,
            base.card_number,
            base.primary_image_url,
            base.mirrored_primary_image_url,
            base.mirrored_primary_thumb_url,
            base.grade,
            base.market_price,
            base.market_price_as_of,
            base.market_confidence_score,
            base.market_low_confidence,
            base.active_listings_7d,
            base.snapshot_count_30d,
            base.change_pct_24h,
            base.change_pct_7d,
            base.jp_latest_price,
            base.jp_latest_price_as_of,
            base.yahoo_jp_price,
            base.yahoo_jp_price_jpy,
            base.yahoo_jp_sample_count,
            base.yahoo_jp_observed_at,
            base.snkrdunk_price,
            base.snkrdunk_price_jpy,
            base.snkrdunk_sample_count,
            base.snkrdunk_observed_at,
            base.snkrdunk_product_code,
            base.market_price IS NOT NULL AND base.market_price > 0::numeric AS has_market_price,
            base.yahoo_jp_price IS NOT NULL AND base.yahoo_jp_price > 0::numeric AND COALESCE(base.yahoo_jp_sample_count, 0) >= 3 AS yahoo_jp_qualified,
            base.snkrdunk_price IS NOT NULL AND base.snkrdunk_price > 0::numeric AND COALESCE(base.snkrdunk_sample_count, 0) >= 3 AS snkrdunk_qualified
           FROM base
        ), picked AS (
         SELECT qualified.canonical_slug,
            qualified.canonical_name,
            qualified.set_name,
            qualified.year,
            qualified.card_number,
            qualified.primary_image_url,
            qualified.mirrored_primary_image_url,
            qualified.mirrored_primary_thumb_url,
            qualified.grade,
            qualified.market_price,
            qualified.market_price_as_of,
            qualified.market_confidence_score,
            qualified.market_low_confidence,
            qualified.active_listings_7d,
            qualified.snapshot_count_30d,
            qualified.change_pct_24h,
            qualified.change_pct_7d,
            qualified.jp_latest_price,
            qualified.jp_latest_price_as_of,
            qualified.yahoo_jp_price,
            qualified.yahoo_jp_price_jpy,
            qualified.yahoo_jp_sample_count,
            qualified.yahoo_jp_observed_at,
            qualified.snkrdunk_price,
            qualified.snkrdunk_price_jpy,
            qualified.snkrdunk_sample_count,
            qualified.snkrdunk_observed_at,
            qualified.snkrdunk_product_code,
            qualified.has_market_price,
            qualified.yahoo_jp_qualified,
            qualified.snkrdunk_qualified,
                CASE
                    WHEN qualified.snkrdunk_qualified AND (NOT qualified.yahoo_jp_qualified OR COALESCE(qualified.snkrdunk_sample_count, 0) > COALESCE(qualified.yahoo_jp_sample_count, 0)) THEN 'snkrdunk'::text
                    WHEN qualified.yahoo_jp_qualified THEN 'yahoo_jp'::text
                    ELSE NULL::text
                END AS picked_jp_source
           FROM qualified
        )
 SELECT canonical_slug,
    canonical_name,
    set_name,
    year,
    card_number,
    primary_image_url,
    mirrored_primary_image_url,
    mirrored_primary_thumb_url,
    grade,
    market_price,
    market_price_as_of,
    market_confidence_score,
    market_low_confidence,
    active_listings_7d,
    snapshot_count_30d,
    change_pct_24h,
    change_pct_7d,
    yahoo_jp_price,
    yahoo_jp_price_jpy,
    yahoo_jp_sample_count,
    yahoo_jp_observed_at,
    snkrdunk_price,
    snkrdunk_price_jpy,
    snkrdunk_sample_count,
    snkrdunk_observed_at,
    snkrdunk_product_code,
    has_market_price,
    yahoo_jp_qualified,
    snkrdunk_qualified,
    yahoo_jp_qualified OR snkrdunk_qualified AS has_qualified_jp_source_price,
        CASE
            WHEN picked_jp_source IS NOT NULL THEN picked_jp_source
            WHEN has_market_price THEN 'market'::text
            ELSE NULL::text
        END AS display_price_source,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_price
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_price
            WHEN has_market_price THEN market_price
            ELSE NULL::numeric
        END AS display_price_usd,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_price_jpy
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_price_jpy
            ELSE NULL::numeric
        END AS display_price_jpy,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_sample_count
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_sample_count
            WHEN has_market_price THEN snapshot_count_30d
            ELSE NULL::integer
        END AS display_price_sample_count,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_observed_at
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_observed_at
            WHEN has_market_price THEN market_price_as_of
            ELSE NULL::timestamp with time zone
        END AS display_price_as_of,
    has_market_price OR yahoo_jp_qualified OR snkrdunk_qualified AS covered_by_price,
    jp_latest_price,
    jp_latest_price_as_of
   FROM picked;

grant select on public.public_jp_price_coverage to anon, authenticated;

comment on view public.public_jp_price_coverage is
  'Public read view for JP card price coverage. Starts from JP canonical_cards and exposes a trusted display price from Yahoo! JP, Snkrdunk, or the guarded public_card_metrics market price without granting direct access to private JP companion price tables.';

-- 4. Drop the retired column.
alter table public.card_metrics drop column if exists justtcg_price;
