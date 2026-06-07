-- 20260607120000_card_metrics_raw_row_history_fallback.sql
--
-- supersedes: 20260605030000_canonical_raw_mirrors_preferred_printing.sql
--
-- Keep a card's canonical/per-printing RAW card_metrics row alive + priced from
-- the freshest genuine-raw signal -- price_snapshots OR price_history_points --
-- instead of price_snapshots alone.
--
-- THE BUG: refresh_card_metrics builds every row from price_snapshots (30d). The
-- same Scrydex raw feed also lands in price_history_points, and for a handful of
-- cards the two diverged: the price_snapshots RAW row went stale while the
-- history RAW series stayed fresh. When the stale snapshot crossed 30 days the
-- card lost its RAW row entirely (base_stats produced nothing AND the
-- delete-scope pruned it), even though a fresh raw price was sitting in history.
-- Example: ascended-heroes-286-n-s-zoroark-ex (N's Zoroark ex) -- last RAW
-- snapshot 2026-05-07 ($197.96, aged out), but history has $194.99 today.
-- Scope is tiny (~9 cards) -- the raw snapshot feed is healthy for ~30k of 33k.
--
-- THE FIX (fallback, zero blast radius on healthy cards): add a genuine-raw
-- history source -- variant_ref like '%::RAW' and not like '%GRADED%',
-- source_window in ('snapshot','30d') -- gated NOT EXISTS(fresh raw snapshot for
-- that slug/printing). Wired into three points in BOTH refresh_card_metrics()
-- and refresh_card_metrics_for_variants(keys): (1) all_prices_raw (row existence
-- + median), (2) printing_compare (market price), (3) active_keys (delete-scope
-- guard). Cards WITH a fresh raw snapshot are excluded by the NOT EXISTS, so the
-- ~30k healthy cards are unchanged. The canonical-RAW preferred-printing mirror
-- (computed_mirrored, from 20260605030000) is preserved verbatim; the
-- per-printing display (refresh_per_printing_raw_price_display) already reads
-- history and fills the headline once the row exists.
--
-- Bodies below are the live definitions (from 20260605030000) reproduced verbatim
-- except the three fallback wire-ins described above. Data correction is
-- post-merge (scoped refresh of the affected slugs), NOT in this migration.

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
  with raw_history_pts as (
    -- Genuine-raw Scrydex history (same daily raw feed that powers the
    -- per-printing display); fallback price source so a card keeps its RAW row
    -- alive + priced when its price_snapshots RAW row has gone stale.
    select
      php.canonical_slug,
      case
        when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(php.variant_ref, '::', 1)::uuid
        else null::uuid
      end as printing_id,
      php.price as price_value,
      php.ts as observed_at
    from public.price_history_points php
    where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and php.source_window in ('snapshot', '30d')
      and php.ts >= now() - interval '30 days'
      and php.variant_ref like '%::RAW'
      and php.variant_ref not like '%GRADED%'
  ),
  snapshot_raw_keys as (
    -- (slug, printing) combos that already have a fresh raw snapshot; the history
    -- fallback is suppressed for these so the ~30k healthy cards are unchanged.
    select distinct canonical_slug, printing_id
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and grade = 'RAW'
      and observed_at >= now() - interval '30 days'
  ),
  raw_history_fallback as (
    select rhp.canonical_slug, rhp.printing_id, rhp.price_value, rhp.observed_at
    from raw_history_pts rhp
    where rhp.printing_id is not null
      and not exists (
        select 1 from snapshot_raw_keys k
        where k.canonical_slug = rhp.canonical_slug
          and k.printing_id is not distinct from rhp.printing_id
      )
  ),
  raw_history_latest as (
    select distinct on (canonical_slug, printing_id)
      canonical_slug, printing_id, price_value, observed_at
    from raw_history_fallback
    order by canonical_slug, printing_id, observed_at desc
  ),
  all_prices_raw as (
    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'

    union all

    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value,
      observed_at
    from raw_history_fallback
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

    union all

    -- history fallback market price for printings with no fresh raw snapshot
    -- (disjoint from the snapshot arm by raw_history_fallback's NOT EXISTS gate).
    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value as scrydex_price,
      observed_at as scrydex_as_of
    from raw_history_latest
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
  -- NEW: canonical RAW row mirrors the preferred printing's stats instead of the
  -- pooled cross-printing aggregate. Only fires for (printing_id IS NULL, RAW);
  -- every other row passes through unchanged. Gated on pref EXISTENCE
  -- (pref.canonical_slug is not null): present -> use the preferred printing's
  -- stats verbatim incl. NULLs; absent -> keep the pooled fallback.
  computed_mirrored as (
    select
      c.canonical_slug,
      c.printing_id,
      c.grade,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_7d else c.median_7d end as median_7d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_30d else c.median_30d end as median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.low_30d else c.low_30d end as low_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.high_30d else c.high_30d end as high_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.trimmed_median_30d else c.trimmed_median_30d end as trimmed_median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.volatility_30d else c.volatility_30d end as volatility_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.liquidity_score else c.liquidity_score end as liquidity_score,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.active_7d_count else c.active_7d_count end as active_7d_count,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.snapshot_count_30d else c.snapshot_count_30d end as snapshot_count_30d,
      c.scrydex_price,
      c.market_price,
      c.market_price_as_of,
      c.provider_compare_as_of
    from computed c
    left join computed pref
      on c.printing_id is null
     and c.grade = 'RAW'
     and pref.canonical_slug = c.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(c.canonical_slug)
     and pref.grade = 'RAW'
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
    from computed_mirrored c
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

  with raw_history_fallback_keys as (
    -- mirror of the INSERT block's raw_history_fallback (separate CTE scope):
    -- (slug, printing) RAW combos kept alive by fresh genuine-raw history when no
    -- fresh raw snapshot exists. Guards the delete-scope from pruning them.
    select distinct rp.canonical_slug, rp.printing_id
    from (
      select
        php.canonical_slug,
        case
          when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then split_part(php.variant_ref, '::', 1)::uuid
          else null::uuid
        end as printing_id
      from public.price_history_points php
      where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
        and php.source_window in ('snapshot', '30d')
        and php.ts >= now() - interval '30 days'
        and php.variant_ref like '%::RAW'
        and php.variant_ref not like '%GRADED%'
    ) rp
    where rp.printing_id is not null
      and not exists (
        select 1 from public.price_snapshots ps
        where ps.canonical_slug = rp.canonical_slug
          and ps.grade = 'RAW'
          and ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
          and ps.observed_at >= now() - interval '30 days'
          and ps.printing_id is not distinct from rp.printing_id
      )
  ),
  active_keys as (
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

    union

    select canonical_slug, printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys

    union

    select canonical_slug, null::uuid as printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys
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

  with raw_history_pts as (
    -- see refresh_card_metrics() for rationale; scoped to v_target_slugs here.
    select
      php.canonical_slug,
      case
        when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(php.variant_ref, '::', 1)::uuid
        else null::uuid
      end as printing_id,
      php.price as price_value,
      php.ts as observed_at
    from public.price_history_points php
    where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and php.source_window in ('snapshot', '30d')
      and php.ts >= now() - interval '30 days'
      and php.variant_ref like '%::RAW'
      and php.variant_ref not like '%GRADED%'
      and php.canonical_slug = any(v_target_slugs)
  ),
  snapshot_raw_keys as (
    select distinct canonical_slug, printing_id
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and grade = 'RAW'
      and observed_at >= now() - interval '30 days'
      and canonical_slug = any(v_target_slugs)
  ),
  raw_history_fallback as (
    select rhp.canonical_slug, rhp.printing_id, rhp.price_value, rhp.observed_at
    from raw_history_pts rhp
    where rhp.printing_id is not null
      and not exists (
        select 1 from snapshot_raw_keys k
        where k.canonical_slug = rhp.canonical_slug
          and k.printing_id is not distinct from rhp.printing_id
      )
  ),
  raw_history_latest as (
    select distinct on (canonical_slug, printing_id)
      canonical_slug, printing_id, price_value, observed_at
    from raw_history_fallback
    order by canonical_slug, printing_id, observed_at desc
  ),
  all_prices_raw as (
    select
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(v_target_slugs)

    union all

    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value,
      observed_at
    from raw_history_fallback
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

    union all

    -- history fallback market price for printings with no fresh raw snapshot
    -- (disjoint from the snapshot arm by raw_history_fallback's NOT EXISTS gate).
    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value as scrydex_price,
      observed_at as scrydex_as_of
    from raw_history_latest
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
  -- NEW: canonical RAW row mirrors the preferred printing's stats (see the full
  -- refresh_card_metrics above for rationale). Same surgical change.
  computed_mirrored as (
    select
      c.canonical_slug,
      c.printing_id,
      c.grade,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_7d else c.median_7d end as median_7d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_30d else c.median_30d end as median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.low_30d else c.low_30d end as low_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.high_30d else c.high_30d end as high_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.trimmed_median_30d else c.trimmed_median_30d end as trimmed_median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.volatility_30d else c.volatility_30d end as volatility_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.liquidity_score else c.liquidity_score end as liquidity_score,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.active_7d_count else c.active_7d_count end as active_7d_count,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.snapshot_count_30d else c.snapshot_count_30d end as snapshot_count_30d,
      c.scrydex_price,
      c.market_price,
      c.market_price_as_of,
      c.provider_compare_as_of
    from computed c
    left join computed pref
      on c.printing_id is null
     and c.grade = 'RAW'
     and pref.canonical_slug = c.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(c.canonical_slug)
     and pref.grade = 'RAW'
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
    from computed_mirrored c
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

  with raw_history_fallback_keys as (
    -- scoped mirror of the INSERT block's raw_history_fallback; guards the
    -- delete-scope from pruning RAW rows kept alive by fresh genuine-raw history.
    select distinct rp.canonical_slug, rp.printing_id
    from (
      select
        php.canonical_slug,
        case
          when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then split_part(php.variant_ref, '::', 1)::uuid
          else null::uuid
        end as printing_id
      from public.price_history_points php
      where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
        and php.source_window in ('snapshot', '30d')
        and php.ts >= now() - interval '30 days'
        and php.variant_ref like '%::RAW'
        and php.variant_ref not like '%GRADED%'
        and php.canonical_slug = any(v_target_slugs)
    ) rp
    where rp.printing_id is not null
      and not exists (
        select 1 from public.price_snapshots ps
        where ps.canonical_slug = rp.canonical_slug
          and ps.grade = 'RAW'
          and ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
          and ps.observed_at >= now() - interval '30 days'
          and ps.printing_id is not distinct from rp.printing_id
      )
  ),
  active_keys as (
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

    union

    select canonical_slug, printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys

    union

    select canonical_slug, null::uuid as printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys
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
