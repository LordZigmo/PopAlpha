-- FINAL JustTCG scrub (PR 2 of 2): remove the last active JUSTTCG references
-- from the metrics/signals functions and the two display views, then purge the
-- stale JUSTTCG rows from variant_metrics.
--
-- JustTCG is a fully-retired pricing provider: ingestion stopped 2026-03-09 and
-- the last JUSTTCG price observation (variant_metrics.provider_as_of_ts) is
-- frozen at 2026-03-09, well outside every refresh window. PR #181 dropped
-- card_metrics.justtcg_price; PR #182 scrubbed the provider-parity subsystem
-- (canonical_raw_provider_parity + its three refresh/confidence functions). This
-- migration completes the cleanup. ZERO behavioral change to anything live:
-- every reference removed here is provably dead.
--
-- 1) refresh_card_metrics() / refresh_card_metrics_for_variants(jsonb): each
--    carried 3 dead `null::timestamptz as justtcg_as_of` aliases inside the
--    printing_compare / canonical_fallback_compare / canonical_compare CTEs.
--    card_metrics has no justtcg_as_of column and nothing selects this alias
--    (it is never referenced after the CTEs), so the aliases are pure local
--    dead columns. They are removed symmetrically from all three CTEs so the
--    `provider_compare` UNION ALL arm column counts stay matched (6 -> 5 in
--    every arm). Every surviving column->value mapping is byte-identical to the
--    live function for every row. Bodies are lifted verbatim from the live
--    pg_get_functiondef (which equals their latest definer 20260604170000),
--    minus only those 6 lines. CREATE OR REPLACE preserves owner, EXECUTE
--    grants, and the SET search_path / statement_timeout / lock_timeout config;
--    all SET clauses are restated below exactly as live.
-- supersedes: 20260604170000_drop_justtcg_price_column.sql  (refresh_card_metrics)
-- supersedes: 20260604170000_drop_justtcg_price_column.sql  (refresh_card_metrics_for_variants)
--
-- 2) market_snapshot_rollups: the base CTE filtered
--    listing_observations.source = ANY (ARRAY['EBAY','TCGPLAYER','JUSTTCG']).
--    JUSTTCG never produced listing_observations rows (it was a price-API
--    provider, not a marketplace listing source), so dropping that one array
--    element changes no row. Column set is unchanged -> CREATE OR REPLACE is
--    sufficient. This view is internal-only (no anon/authenticated grants, per
--    PHASE3_INTERNAL_NO_GRANT_VIEWS); CREATE OR REPLACE leaves its grants
--    untouched and live shows no non-default grants, so none are re-applied.
--
-- 3) public_card_display_identity: the provider-priority CASE in
--    ranked_provider_numbers had a `WHEN 'JUSTTCG'::text THEN 0` arm. JUSTTCG
--    rows no longer exist in provider_card_map (retired), so the arm is
--    unreachable; the remaining priorities (POKEMON_TCG_API=1, SCRYDEX=2,
--    ELSE=9) preserve the exact ordering among providers that actually occur.
--    Column set is unchanged -> CREATE OR REPLACE. This view IS publicly
--    readable (anon/authenticated SELECT, per PUBLIC_VIEW_NAMES); CREATE OR
--    REPLACE preserves existing grants, but the SELECT grants are re-applied
--    below as belt-and-suspenders to match the live ACL exactly.
--
-- 4) refresh_derived_signals(): an obsolete JUSTTCG-only full-refresh whose
--    root CTE is `from public.variant_metrics where provider = 'JUSTTCG'`. It is
--    the ONLY database object (verified across all views/matviews/functions)
--    that reads JUSTTCG variant_metrics rows, and the ONLY app caller is the
--    refresh-derived-signals cron's dead happy-path branch (removed in the
--    accompanying route edit). The real per-variant work runs through
--    refresh_derived_signals_for_variants(jsonb), which is unaffected.
--
-- 5) DELETE FROM variant_metrics WHERE provider = 'JUSTTCG' (~23.3k rows). Safe:
--    the price data is frozen at 2026-03-09 (outside all windows); the only
--    thing still touching these rows was refresh_derived_signals() (dropped in
--    step 4), which recomputed signals nightly from that frozen data for no
--    consumer. No view, function, or app code reads variant_metrics JUSTTCG
--    rows after step 4.

-- 1) refresh_card_metrics(): drop the 3 dead justtcg_as_of aliases.
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

-- 2) refresh_card_metrics_for_variants(jsonb): same treatment, mirrored.
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

-- 3) market_snapshot_rollups: drop the dead 'JUSTTCG' source array element.
CREATE OR REPLACE VIEW public.market_snapshot_rollups AS
 WITH base AS (
         SELECT listing_observations.canonical_slug,
            listing_observations.printing_id,
            COALESCE(listing_observations.grade, 'RAW'::text) AS grade,
            listing_observations.external_id AS external_listing_id,
            listing_observations.price_value AS price_usd,
            listing_observations.observed_at
           FROM listing_observations
          WHERE (listing_observations.source = ANY (ARRAY['EBAY'::text, 'TCGPLAYER'::text])) AND listing_observations.currency = 'USD'::text AND listing_observations.price_value > 0::numeric AND listing_observations.canonical_slug IS NOT NULL
        ), window_30d AS (
         SELECT base.canonical_slug,
            base.printing_id,
            base.grade,
            base.price_usd,
            base.observed_at,
            ntile(10) OVER (PARTITION BY base.canonical_slug, base.printing_id, base.grade ORDER BY base.price_usd) AS decile
           FROM base
          WHERE base.observed_at >= (now() - '30 days'::interval)
        ), trimmed AS (
         SELECT window_30d.canonical_slug,
            window_30d.printing_id,
            window_30d.grade,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (window_30d.price_usd::double precision)) AS trimmed_median_30d
           FROM window_30d
          WHERE window_30d.decile >= 2 AND window_30d.decile <= 9
          GROUP BY window_30d.canonical_slug, window_30d.printing_id, window_30d.grade
        )
 SELECT b.canonical_slug,
    b.printing_id,
    b.grade,
    count(DISTINCT
        CASE
            WHEN b.observed_at >= (now() - '7 days'::interval) THEN b.external_listing_id
            ELSE NULL::text
        END) AS active_listings_7d,
    percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (b.price_usd::double precision)) FILTER (WHERE b.observed_at >= (now() - '7 days'::interval)) AS median_ask_7d,
    percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (b.price_usd::double precision)) FILTER (WHERE b.observed_at >= (now() - '30 days'::interval)) AS median_ask_30d,
    min(b.price_usd) FILTER (WHERE b.observed_at >= (now() - '30 days'::interval)) AS low_ask_30d,
    max(b.price_usd) FILTER (WHERE b.observed_at >= (now() - '30 days'::interval)) AS high_ask_30d,
    t.trimmed_median_30d
   FROM base b
     LEFT JOIN trimmed t ON t.canonical_slug = b.canonical_slug AND NOT t.printing_id IS DISTINCT FROM b.printing_id AND t.grade = b.grade
  GROUP BY b.canonical_slug, b.printing_id, b.grade, t.trimmed_median_30d;

-- 4) public_card_display_identity: drop the unreachable 'JUSTTCG' priority arm.
CREATE OR REPLACE VIEW public.public_card_display_identity AS
 WITH provider_numbers AS (
         SELECT pcm.canonical_slug,
            btrim(pcm.metadata ->> 'provider_card_number'::text) AS provider_card_number,
            pcm.provider,
            pcm.updated_at
           FROM provider_card_map pcm
             JOIN canonical_cards cc_1 ON cc_1.slug = pcm.canonical_slug
          WHERE pcm.mapping_status = 'MATCHED'::text AND pcm.canonical_slug IS NOT NULL AND pcm.asset_type = 'single'::text AND btrim(COALESCE(pcm.metadata ->> 'provider_card_number'::text, ''::text)) ~ '^[0-9A-Za-z]+/[0-9A-Za-z]+$'::text AND lower(regexp_replace(split_part(btrim(pcm.metadata ->> 'provider_card_number'::text), '/'::text, 1), '^0+'::text, ''::text)) = lower(regexp_replace(COALESCE(cc_1.card_number, ''::text), '^0+'::text, ''::text))
        ), ranked_provider_numbers AS (
         SELECT provider_numbers.canonical_slug,
            provider_numbers.provider_card_number,
            provider_numbers.provider,
            provider_numbers.updated_at,
            row_number() OVER (PARTITION BY provider_numbers.canonical_slug ORDER BY (
                CASE provider_numbers.provider
                    WHEN 'POKEMON_TCG_API'::text THEN 1
                    WHEN 'SCRYDEX'::text THEN 2
                    ELSE 9
                END), provider_numbers.updated_at DESC, provider_numbers.provider_card_number) AS rn
           FROM provider_numbers
        ), printing_counts AS (
         SELECT cp.canonical_slug,
            count(*)::integer AS printing_count,
            count(DISTINCT COALESCE(cp.finish, 'UNKNOWN'::text))::integer AS finish_count
           FROM card_printings cp
          GROUP BY cp.canonical_slug
        ), preferred_printings AS (
         SELECT cc_1.slug,
            cp.id AS price_printing_id,
            cp.finish AS price_finish,
            cp.edition AS price_edition,
            cp.stamp AS price_stamp
           FROM canonical_cards cc_1
             LEFT JOIN card_printings cp ON cp.id = preferred_canonical_raw_printing(cc_1.slug)
        )
 SELECT cc.slug,
    COALESCE(rpn.provider_card_number, cc.card_number) AS display_card_number,
    rpn.provider_card_number,
    cc.card_number AS canonical_card_number,
    pp.price_printing_id,
    pp.price_finish,
    pp.price_edition,
    pp.price_stamp,
    COALESCE(pc.printing_count, 0) AS printing_count,
    COALESCE(pc.finish_count, 0) AS finish_count,
    COALESCE(pc.printing_count, 0) > 1 AS has_multiple_printings,
    COALESCE(pc.finish_count, 0) > 1 AS has_multiple_finishes
   FROM canonical_cards cc
     LEFT JOIN ranked_provider_numbers rpn ON rpn.canonical_slug = cc.slug AND rpn.rn = 1
     LEFT JOIN printing_counts pc ON pc.canonical_slug = cc.slug
     LEFT JOIN preferred_printings pp ON pp.slug = cc.slug;

-- Re-apply the live SELECT grants on public_card_display_identity (it is in
-- PUBLIC_VIEW_NAMES). CREATE OR REPLACE preserves these already; restated here
-- to match the live ACL (anon=r, authenticated=r) explicitly and idempotently.
GRANT SELECT ON public.public_card_display_identity TO anon;
GRANT SELECT ON public.public_card_display_identity TO authenticated;

-- 5) Drop the obsolete JUSTTCG-only full-refresh signal function. The
--    per-variant path refresh_derived_signals_for_variants(jsonb) is unaffected.
DROP FUNCTION IF EXISTS public.refresh_derived_signals();

-- 6) Purge the frozen, now-unreferenced JUSTTCG signal rows from variant_metrics.
DELETE FROM public.variant_metrics WHERE provider = 'JUSTTCG';
