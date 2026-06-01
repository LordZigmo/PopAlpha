-- Freshest hero price + per-printing display/latest (price-display redesign, step 1).
--
-- Agreed design (user, 2026-06-01): show the FRESHEST price as the hero and the
-- 3-day MEDIAN (newest point included) directly below it — for the canonical
-- card AND for each selected finish/printing, so "the hero follows the finish"
-- and the detail headline always matches the homepage. One value per UI spot, no
-- value overriding another.
--
-- Problem this fixes
-- ------------------
-- 20260531120000 added display_price (3-day median) ONLY to canonical
-- (printing_id IS NULL) RAW rows. The iOS detail re-fetches the per-printing row
-- for the selected finish and lets it take over the hero; per-printing rows have
-- display_price = NULL, so public_card_metrics' EN-RAW COALESCE falls through to
-- the raw scrydex basis. Result: homepage shows the canonical median (e.g.
-- ascended-heroes-295-mega-dragonite-ex $325) but the detail flips to the
-- per-printing raw price ($335.58 today, $315 last week) — a multi-week
-- "two prices for one card" bug.
--
-- Fix (data layer)
-- ----------------
--  1. card_metrics gains latest_price / latest_price_as_of (ADD COLUMN IF NOT
--     EXISTS) — the FRESHEST daily snapshot point (the newest point that the
--     3-day median already folds in).
--  2. refresh_price_changes_core (canonical, printing_id IS NULL): additively
--     persists latest_price = the latest daily point of the same preferred
--     provider+variant daily series it already medians. change_pct_* and
--     display_* computation/writes are byte-for-byte unchanged.
--  3. NEW refresh_per_printing_raw_price_display: for per-printing RAW rows,
--     computes display_price (3-day median), latest_price (freshest day), and the
--     median-basis display_change_pct_* from THAT printing's RAW snapshot daily
--     series (snapshot/7d/30d, source-priority-deduped per day — mirrors the
--     canonical daily series; 99.9% of printings are single-variant so this
--     equals the per-printing chart). ~1.1s for all ~49k rows (index scan).
--     Disjoint from core: core owns printing_id IS NULL rows, this owns
--     printing_id IS NOT NULL rows; no column is double-written.
--  4. Wrappers refresh_price_changes() / refresh_price_changes_for_cards() now
--     call BOTH core and the per-printing function, so the existing crons
--     (refresh-card-metrics, provider-pipeline-rollups) populate per-printing
--     rows with no TypeScript changes.
--  5. public_card_metrics surfaces guarded latest_price / latest_price_as_of
--     (freshest, falling back to the median basis, null whenever the headline is
--     suppressed). market_price stays the 3-day median (the sub-line). Every
--     existing guard / column / JP / graded / non-EN path is preserved.
--
-- For the preferred printing the per-printing series IS the canonical series, so
-- the detail default == homepage (verified: mega-dragonite 894b4f09 → 325/325).
-- For other finishes the hero follows that finish (verified: skyridge-1-aerodactyl
-- reverse-holo 1159.80 vs NON_HOLO 199.95).
--
-- Scope: EN-RAW only (the active bug). Graded / JP freshest+median are follow-ups.
--
-- supersedes: 20260531140000_exclude_graded_from_raw_canonical_series.sql
--             (refresh_price_changes_core — latest prior body. Diffed: identical
--              CTE chain + change_pct_* / display_* computation and UPDATE; this
--              body only ADDS a display_latest CTE and latest_price /
--              latest_price_as_of to the changes select + UPDATE. No existing
--              column dropped or repurposed.)
-- supersedes: 20260502010000_revert_refresh_price_changes_to_core_wrapper.sql
--             (refresh_price_changes() wrapper — now also calls the per-printing
--              function and merges its jsonb result.)
-- supersedes: 20260309224000_fix_price_change_scope_selection.sql
--             (refresh_price_changes_for_cards() wrapper — same scope guard, now
--              also calls the per-printing function for the scoped slugs.)
-- supersedes: 20260531120000_en_raw_chart_series_truth_display_price.sql
--             (public_card_metrics — latest prior body. Diffed: every column,
--              CTE, guard and code path byte-for-byte equivalent EXCEPT two new
--              output columns latest_price / latest_price_as_of, derived from the
--              existing public_market_price suppression so they never expose a
--              price the headline itself hides.)

-- ---------------------------------------------------------------------------
-- 1. New columns on card_metrics.
-- ---------------------------------------------------------------------------
alter table public.card_metrics
  add column if not exists latest_price numeric,
  add column if not exists latest_price_as_of timestamptz;

-- ---------------------------------------------------------------------------
-- 2. refresh_price_changes_core — additively persist canonical latest_price
--    (latest daily point of the preferred daily series).
-- ---------------------------------------------------------------------------
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
  -- Median windows for the chart-series display price + median-basis change.
  -- Rolling 3-day windows on both ends so the hero and the change share one
  -- robust basis (median-now vs median-24h-ago vs median-7d-ago).
  cutoff_3d timestamptz := now() - interval '3 days';
  cutoff_4d timestamptz := now() - interval '4 days';
  cutoff_10d timestamptz := now() - interval '10 days';
begin
  with canonical_scope as (
    select distinct on (cm.canonical_slug)
      cm.canonical_slug,
      cm.scrydex_price as current_scrydex_price,
      pref.id as preferred_printing_id,
      pref.finish as preferred_finish,
      pref.edition as preferred_edition,
      pref.stamp as preferred_stamp
    from public.card_metrics cm
    left join public.card_printings pref
      on pref.id = public.preferred_canonical_raw_printing(cm.canonical_slug)
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
    where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '7d', '30d')
      and ph.ts >= cutoff_14d
      and ph.price is not null
      and ph.price > 0
      -- Ungraded only. This function computes the grade='RAW' canonical row, so
      -- graded variants (segment 3 = 'GRADED') must never feed its price/change.
      and split_part(ph.variant_ref, '::', 3) = 'RAW'
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
      cs.current_scrydex_price as current_provider_price
    from provider_candidates pc
    join canonical_scope cs
      on cs.canonical_slug = pc.canonical_slug
    order by
      pc.canonical_slug,
      case
        when cs.current_scrydex_price is not null and pc.provider_key = 'SCRYDEX' then 5
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
    join canonical_scope cs
      on cs.canonical_slug = vlp.canonical_slug
    order by
      vlp.canonical_slug,
      public.provider_variant_match_score(
        vlp.provider_key,
        vlp.variant_ref,
        cs.preferred_finish,
        cs.preferred_edition,
        cs.preferred_stamp
      ) desc,
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
  -- Chart-series daily buckets over the SAME preferred provider+variant points
  -- that drive price_now. One canonical price per day, snapshot-priority first
  -- (mirrors hourly_points' dedup), so the median is taken over exactly the
  -- daily series the chart plots.
  daily_source_rank as (
    select
      pp.canonical_slug,
      date_trunc('day', pp.ts) as day_ts,
      pp.source_priority,
      avg(pp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket,
      max(pp.ts) as latest_point_ts
    from preferred_points pp
    group by pp.canonical_slug, date_trunc('day', pp.ts), pp.source_priority
  ),
  daily_points as (
    select distinct on (dsr.canonical_slug, dsr.day_ts)
      dsr.canonical_slug,
      dsr.day_ts,
      dsr.canonical_price
    from daily_source_rank dsr
    order by
      dsr.canonical_slug,
      dsr.day_ts,
      dsr.source_priority asc,
      dsr.latest_point_ts desc,
      dsr.points_in_bucket desc
  ),
  -- Freshest hero price = the latest daily point of that same daily series (the
  -- newest point the 3-day median below already folds in). One value, sourced
  -- identically to display_price.
  display_latest as (
    select distinct on (dp.canonical_slug)
      dp.canonical_slug,
      dp.canonical_price as latest_display_price,
      dp.day_ts as latest_display_as_of
    from daily_points dp
    order by dp.canonical_slug, dp.day_ts desc
  ),
  display_medians as (
    select
      dp.canonical_slug,
      (percentile_cont(0.5) within group (order by dp.canonical_price)
        filter (where dp.day_ts > cutoff_3d))::numeric as median_now,
      max(dp.day_ts) filter (where dp.day_ts > cutoff_3d) as median_now_as_of,
      (percentile_cont(0.5) within group (order by dp.canonical_price)
        filter (where dp.day_ts <= cutoff_24h and dp.day_ts > cutoff_4d))::numeric as median_24h,
      (percentile_cont(0.5) within group (order by dp.canonical_price)
        filter (where dp.day_ts <= cutoff_7d and dp.day_ts > cutoff_10d))::numeric as median_7d
    from daily_points dp
    group by dp.canonical_slug
  ),
  display_values as (
    select
      dm.canonical_slug,
      dm.median_now as display_price,
      dm.median_now_as_of as display_price_as_of,
      case
        when dm.median_now is not null
         and dm.median_24h is not null
         and dm.median_24h > 0
        then ((dm.median_now - dm.median_24h) / dm.median_24h) * 100
        else null
      end as display_change_pct_24h,
      case
        when dm.median_now is not null
         and dm.median_7d is not null
         and dm.median_7d > 0
        then ((dm.median_now - dm.median_7d) / dm.median_7d) * 100
        else null
      end as display_change_pct_7d
    from display_medians dm
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
        when cs.current_scrydex_price is not null
          and lp.price_now is not null
          and r24.price_24h is not null
          and r24.price_24h > 0
          and lp.latest_ts > cutoff_24h
          and r24.price_24h_ts < lp.latest_ts
        then ((lp.price_now - r24.price_24h) / r24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when cs.current_scrydex_price is not null
          and lp.price_now is not null
          and r7.price_7d is not null
          and r7.price_7d > 0
          and r7.price_7d_ts < lp.latest_ts
        then ((lp.price_now - r7.price_7d) / r7.price_7d) * 100
        else null
      end as change_pct_7d,
      dv.display_price,
      dv.display_price_as_of,
      dv.display_change_pct_24h,
      dv.display_change_pct_7d,
      dl.latest_display_price as latest_price,
      dl.latest_display_as_of as latest_price_as_of
    from canonical_scope cs
    left join latest_price lp using (canonical_slug)
    left join resolved_24h r24 using (canonical_slug)
    left join resolved_7d r7 using (canonical_slug)
    left join display_values dv using (canonical_slug)
    left join display_latest dl using (canonical_slug)
  ),
  do_update as (
    update public.card_metrics cm
    set
      change_pct_24h = c.change_pct_24h,
      change_pct_7d = c.change_pct_7d,
      display_price = c.display_price,
      display_price_as_of = c.display_price_as_of,
      display_change_pct_24h = c.display_change_pct_24h,
      display_change_pct_7d = c.display_change_pct_7d,
      latest_price = c.latest_price,
      latest_price_as_of = c.latest_price_as_of
    from changes c
    where cm.canonical_slug = c.canonical_slug
      and cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.change_pct_24h is distinct from c.change_pct_24h
        or cm.change_pct_7d is distinct from c.change_pct_7d
        or cm.display_price is distinct from c.display_price
        or cm.display_price_as_of is distinct from c.display_price_as_of
        or cm.display_change_pct_24h is distinct from c.display_change_pct_24h
        or cm.display_change_pct_7d is distinct from c.display_change_pct_7d
        or cm.latest_price is distinct from c.latest_price
        or cm.latest_price_as_of is distinct from c.latest_price_as_of
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

-- ---------------------------------------------------------------------------
-- 3. refresh_per_printing_raw_price_display — per-printing RAW display/latest.
--    Computes from each printing's own RAW snapshot daily series (source-priority
--    deduped per day, mirroring the canonical daily series). Owns ONLY
--    printing_id IS NOT NULL rows; disjoint from refresh_price_changes_core.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_per_printing_raw_price_display(p_canonical_slugs text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  cutoff_14d timestamptz := now() - interval '14 days';
  cutoff_24h timestamptz := now() - interval '24 hours';
  cutoff_7d timestamptz := now() - interval '7 days';
  cutoff_3d timestamptz := now() - interval '3 days';
  cutoff_4d timestamptz := now() - interval '4 days';
  cutoff_10d timestamptz := now() - interval '10 days';
begin
  with pp_scope as (
    select cm.id as metric_id, cm.canonical_slug, cm.printing_id
    from public.card_metrics cm
    where cm.grade = 'RAW'
      and cm.printing_id is not null
      and cm.canonical_slug is not null
      and (
        p_canonical_slugs is null
        or cm.canonical_slug = any(p_canonical_slugs)
      )
  ),
  daily_source_rank as (
    select
      s.metric_id,
      date_trunc('day', ph.ts) as day_ts,
      case
        when ph.source_window = 'snapshot' then 1
        when ph.source_window = '7d' then 2
        when ph.source_window = '30d' then 3
        else 9
      end::int as source_priority,
      avg(ph.price)::numeric as day_price,
      count(*)::integer as points_in_bucket,
      max(ph.ts) as latest_point_ts
    from pp_scope s
    join public.price_history_points ph
      on ph.canonical_slug = s.canonical_slug
     and ph.printing_id = s.printing_id
    where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '7d', '30d')
      and ph.ts >= cutoff_14d
      and ph.price is not null
      and ph.price > 0
      -- Ungraded only (graded refs also end in ::RAW; discriminator is seg 3).
      and split_part(ph.variant_ref, '::', 3) = 'RAW'
    group by
      s.metric_id,
      date_trunc('day', ph.ts),
      case
        when ph.source_window = 'snapshot' then 1
        when ph.source_window = '7d' then 2
        when ph.source_window = '30d' then 3
        else 9
      end
  ),
  daily_points as (
    select distinct on (dsr.metric_id, dsr.day_ts)
      dsr.metric_id,
      dsr.day_ts,
      dsr.day_price
    from daily_source_rank dsr
    order by
      dsr.metric_id,
      dsr.day_ts,
      dsr.source_priority asc,
      dsr.latest_point_ts desc,
      dsr.points_in_bucket desc
  ),
  medians as (
    select
      dp.metric_id,
      (percentile_cont(0.5) within group (order by dp.day_price)
        filter (where dp.day_ts > cutoff_3d))::numeric as median_now,
      max(dp.day_ts) filter (where dp.day_ts > cutoff_3d) as median_now_as_of,
      (percentile_cont(0.5) within group (order by dp.day_price)
        filter (where dp.day_ts <= cutoff_24h and dp.day_ts > cutoff_4d))::numeric as median_24h,
      (percentile_cont(0.5) within group (order by dp.day_price)
        filter (where dp.day_ts <= cutoff_7d and dp.day_ts > cutoff_10d))::numeric as median_7d
    from daily_points dp
    group by dp.metric_id
  ),
  latest_daily as (
    select distinct on (dp.metric_id)
      dp.metric_id,
      dp.day_price as latest_price,
      dp.day_ts as latest_price_as_of
    from daily_points dp
    order by dp.metric_id, dp.day_ts desc
  ),
  vals as (
    select
      m.metric_id,
      m.median_now as display_price,
      m.median_now_as_of as display_price_as_of,
      ld.latest_price,
      ld.latest_price_as_of,
      case
        when m.median_now is not null and m.median_24h is not null and m.median_24h > 0
        then ((m.median_now - m.median_24h) / m.median_24h) * 100
        else null
      end as display_change_pct_24h,
      case
        when m.median_now is not null and m.median_7d is not null and m.median_7d > 0
        then ((m.median_now - m.median_7d) / m.median_7d) * 100
        else null
      end as display_change_pct_7d
    from medians m
    left join latest_daily ld using (metric_id)
  ),
  do_update as (
    update public.card_metrics cm
    set
      display_price = v.display_price,
      display_price_as_of = v.display_price_as_of,
      latest_price = v.latest_price,
      latest_price_as_of = v.latest_price_as_of,
      display_change_pct_24h = v.display_change_pct_24h,
      display_change_pct_7d = v.display_change_pct_7d
    from pp_scope s
    left join vals v on v.metric_id = s.metric_id
    where cm.id = s.metric_id
      and (
        cm.display_price is distinct from v.display_price
        or cm.display_price_as_of is distinct from v.display_price_as_of
        or cm.latest_price is distinct from v.latest_price
        or cm.latest_price_as_of is distinct from v.latest_price_as_of
        or cm.display_change_pct_24h is distinct from v.display_change_pct_24h
        or cm.display_change_pct_7d is distinct from v.display_change_pct_7d
      )
    returning 1
  )
  select count(*) into updated_count from do_update;

  return jsonb_build_object('pp_updated', updated_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Wrappers now drive BOTH canonical and per-printing display refresh, so the
--    existing crons populate per-printing rows with no app-code change.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_price_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  v_core jsonb;
  v_pp jsonb;
begin
  v_core := public.refresh_price_changes_core(null);
  v_pp := public.refresh_per_printing_raw_price_display(null);
  return v_core || v_pp;
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
  v_scope text[];
  v_core jsonb;
  v_pp jsonb;
begin
  select coalesce(array_agg(distinct scope_slug), '{}'::text[])
  into v_scope
  from unnest(coalesce(p_canonical_slugs, '{}'::text[])) as input(scope_slug)
  where scope_slug is not null
    and trim(scope_slug) <> '';

  if coalesce(array_length(v_scope, 1), 0) = 0 then
    return jsonb_build_object(
      'updated', 0,
      'nulled', 0,
      'pp_updated', 0
    );
  end if;

  v_core := public.refresh_price_changes_core(v_scope);
  v_pp := public.refresh_per_printing_raw_price_display(v_scope);
  return v_core || v_pp;
end;
$$;

-- SECURITY DEFINER lockdown: the new function writes card_metrics, so it must
-- not be callable by anon/authenticated. The service-role crons bypass grants.
revoke all on function public.refresh_per_printing_raw_price_display(text[]) from public, anon, authenticated;
revoke all on function public.refresh_price_changes() from public, anon, authenticated;
revoke all on function public.refresh_price_changes_for_cards(text[]) from public, anon, authenticated;
revoke all on function public.refresh_price_changes_core(text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. public_card_metrics — surface guarded latest_price / latest_price_as_of
--    (freshest hero), keeping market_price as the 3-day median (the sub-line).
-- ---------------------------------------------------------------------------
create or replace view public.public_card_metrics as
with metric_rows as (
  select
    base_cm.*,
    (
      base_cm.grade = 'RAW'
      and base_cm.market_price is not null
      and coalesce(base_cm.snapshot_count_30d, 0) >= 5
      and base_cm.market_price > (
        greatest(
          coalesce(nullif(base_cm.median_7d, 0), 0),
          coalesce(nullif(base_cm.median_30d, 0), 0),
          coalesce(nullif(base_cm.trimmed_median_30d, 0), 0),
          coalesce(nullif(base_cm.low_30d, 0), 0),
          1
        ) * 20
      )
    ) as raw_market_price_outlier
  from public.card_metrics base_cm
),
joined_rows as (
  select
    cm.*,
    cc.canonical_name_native,
    cc.set_name_native,
    cc.language as canonical_language,
    (cc.language = 'EN' and cm.grade = 'RAW') as is_en_raw,
    ctrp.trust_status as private_trust_status,
    ctrp.trusted_price_usd as private_trusted_price_usd,
    ctrp.trusted_price_as_of as private_trusted_price_as_of,
    ctrp.trusted_price_source as private_trusted_price_source,
    ctrp.pricecharting_price_usd as private_guardrail_price_usd,
    ctrp.pricecharting_as_of as private_guardrail_as_of,
    ctrp.scrydex_price_usd as private_scrydex_price_usd,
    ctrp.scrydex_as_of as private_scrydex_as_of,
    ctrp.quarantine_reason as private_quarantine_reason,
    coalesce(yjp_specific.price_usd, yjp_canonical.price_usd) as yahoo_jp_price_out,
    coalesce(yjp_specific.price_jpy, yjp_canonical.price_jpy) as yahoo_jp_price_jpy_out,
    coalesce(yjp_specific.sample_count, yjp_canonical.sample_count) as yahoo_jp_sample_count_out,
    coalesce(yjp_specific.observed_at, yjp_canonical.observed_at) as yahoo_jp_observed_at_out,
    coalesce(snk_specific.price_usd, snk_canonical.price_usd) as snkrdunk_price_out,
    coalesce(snk_specific.sample_count, snk_canonical.sample_count) as snkrdunk_sample_count_out,
    coalesce(snk_specific.observed_at, snk_canonical.observed_at) as snkrdunk_observed_at_out,
    coalesce(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) as snkrdunk_product_code_out,
    coalesce(snk_specific.price_jpy, snk_canonical.price_jpy) as snkrdunk_price_jpy_out
  from metric_rows cm
  left join public.yahoo_jp_card_prices yjp_specific
    on yjp_specific.canonical_slug = cm.canonical_slug
   and yjp_specific.printing_id = cm.printing_id
   and yjp_specific.grade = cm.grade
  left join public.yahoo_jp_card_prices yjp_canonical
    on yjp_canonical.canonical_slug = cm.canonical_slug
   and yjp_canonical.printing_id is null
   and yjp_canonical.grade = cm.grade
  left join public.snkrdunk_card_prices snk_specific
    on snk_specific.canonical_slug = cm.canonical_slug
   and snk_specific.printing_id = cm.printing_id
   and snk_specific.grade = cm.grade
  left join public.snkrdunk_card_prices snk_canonical
    on snk_canonical.canonical_slug = cm.canonical_slug
   and snk_canonical.printing_id is null
   and snk_canonical.grade = cm.grade
  left join public.canonical_cards cc
    on cc.slug = cm.canonical_slug
  left join public.canonical_trusted_raw_prices ctrp
    on ctrp.canonical_slug = cm.canonical_slug
   and ctrp.printing_id is not distinct from cm.printing_id
),
public_price_policy as (
  select
    j.*,
    case
      when j.is_en_raw then
        -- Chart-series-truth: EN-RAW headline derives from the Scrydex daily
        -- snapshot median (display_price), the same series the chart plots.
        -- COALESCE to the prior basis when no snapshot series exists (chart is
        -- then sparse/empty too, so nothing to be inconsistent with). All
        -- suppression branches below still hard-null exactly as before.
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.display_price, j.private_trusted_price_usd)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.display_price, j.private_scrydex_price_usd, j.market_price)
          else coalesce(j.display_price, j.market_price)
        end
      when j.raw_market_price_outlier then null
      else j.market_price
    end as public_market_price,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                 end
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.market_price_as_of)
                 end
          else case
                 when j.display_price is not null then j.display_price_as_of
                 else j.market_price_as_of
               end
        end
      when j.raw_market_price_outlier then null
      else j.market_price_as_of
    end as public_market_price_as_of,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.private_scrydex_as_of, j.provider_compare_as_of)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.provider_compare_as_of)
          else j.provider_compare_as_of
        end
      when j.raw_market_price_outlier then null
      else j.provider_compare_as_of
    end as public_provider_compare_as_of
  from joined_rows j
),
public_signal_policy as (
  select
    p.*,
    -- Freshest hero price. Same suppression as the headline (null when the
    -- median headline is hidden). For EN-RAW: the freshest daily snapshot point,
    -- falling back to the median basis so the hero never blanks. For JP / graded
    -- (non-EN-RAW): mirror the headline price — their hero comes from JP-native /
    -- graded sources, not the Scrydex snapshot the latest_price column holds, so
    -- never surface a snapshot-derived freshest here (a later step wires their
    -- own freshest+median). One value per spot, never a competing basis.
    case
      when p.public_market_price is null then null
      when p.is_en_raw then coalesce(p.latest_price, p.public_market_price)
      else p.public_market_price
    end as public_latest_price,
    case
      when p.public_market_price is null then null
      when p.is_en_raw then coalesce(p.latest_price_as_of, p.public_market_price_as_of)
      else p.public_market_price_as_of
    end as public_latest_price_as_of,
    case
      when p.is_en_raw then
        -- Median-basis change so the hero and the change % are coherent. Use
        -- the display change when the headline itself came from display_price;
        -- otherwise fall back to the prior change basis under the same guard.
        case
          when p.public_market_price is null then null
          when p.display_price is not null then p.display_change_pct_24h
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then p.change_pct_24h
          else null
        end
      when p.raw_market_price_outlier then null
      else p.change_pct_24h
    end as public_change_pct_24h,
    case
      when p.is_en_raw then
        case
          when p.public_market_price is null then null
          when p.display_price is not null then p.display_change_pct_7d
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then p.change_pct_7d
          else null
        end
      when p.raw_market_price_outlier then null
      else p.change_pct_7d
    end as public_change_pct_7d,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 90
          when p.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then 0
          when p.raw_market_price_outlier
            then 0
          when p.public_market_price is not null
            then least(coalesce(p.market_confidence_score, 25), 35)
          else 0
        end
      when p.raw_market_price_outlier then 0
      else p.market_confidence_score
    end as public_confidence_score,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then false
          else true
        end
      when p.raw_market_price_outlier then true
      else p.market_low_confidence
    end as public_low_confidence,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 'POPALPHA_MARKET_CONFIDENT'
          when p.private_trust_status = 'PRICECHARTING_DIVERGED'
            then 'POPALPHA_MARKET_QUARANTINED'
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
            then 'NO_RELIABLE_PRICE'
          when p.raw_market_price_outlier
            then 'OUTLIER_SUPPRESSED'
          when p.public_market_price is not null
            then 'POPALPHA_MARKET_LOW_CONFIDENCE'
          else 'NO_RELIABLE_PRICE'
        end
      when p.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
      else p.market_blend_policy
    end as public_market_blend_policy
  from public_price_policy p
),
public_signal_context as (
  select
    s.*,
    case
      when s.is_en_raw
       and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
       and s.public_market_price is not null
       and s.private_scrydex_price_usd is not null
        then s.private_scrydex_price_usd
      else null
    end as recent_market_signal_usd,
    case
      when s.is_en_raw
       and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
       and s.public_market_price is not null
       and s.private_scrydex_price_usd is not null
        then s.private_scrydex_as_of
      else null
    end as recent_market_signal_as_of
  from public_signal_policy s
),
public_signal_gap as (
  select
    c.*,
    case
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
        then round((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric, 2)
      else null
    end as recent_market_signal_delta_pct,
    case
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
       and abs((c.recent_market_signal_usd - c.public_market_price)::numeric) >=
          case
            when c.public_market_price < 25 then 1
            when c.public_market_price < 100 then 5
            when c.public_market_price < 500 then 25
            else 50
          end
       and abs((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric) >=
          case
            when c.public_market_price < 25 then 20
            when c.public_market_price < 100 then 15
            when c.public_market_price < 500 then 10
            else 8
          end
       and c.recent_market_signal_usd > c.public_market_price
        then 'HIGHER'
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
       and abs((c.recent_market_signal_usd - c.public_market_price)::numeric) >=
          case
            when c.public_market_price < 25 then 1
            when c.public_market_price < 100 then 5
            when c.public_market_price < 500 then 25
            else 50
          end
       and abs((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric) >=
          case
            when c.public_market_price < 25 then 20
            when c.public_market_price < 100 then 15
            when c.public_market_price < 500 then 10
            else 8
          end
       and c.recent_market_signal_usd < c.public_market_price
        then 'LOWER'
      else null
    end as recent_market_signal_direction
  from public_signal_context c
),
public_display_policy as (
  select
    g.*,
    case
      when g.is_en_raw
       and (g.private_trust_status = 'PRICECHARTING_DIVERGED' or g.raw_market_price_outlier)
       and g.public_market_price is null
        then 'UNDER_REVIEW'
      when g.public_market_price is null
        then 'NO_RELIABLE_PRICE'
      when g.is_en_raw
       and g.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
        then 'PUBLIC_ONLY'
      when g.recent_market_signal_direction = 'HIGHER'
        then 'SIGNAL_HIGHER'
      when g.recent_market_signal_direction = 'LOWER'
        then 'SIGNAL_LOWER'
      else 'ALIGNED'
    end as market_price_display_state
  from public_signal_gap g
),
public_provenance_policy as (
  select
    s.*,
    case
      when s.is_en_raw then
        jsonb_strip_nulls(jsonb_build_object(
          'marketPriceLabel', 'PopAlpha Market Price',
          'marketPriceDisplayState', s.market_price_display_state,
          'recentMarketSignalDirection', s.recent_market_signal_direction,
          'recentMarketSignalDeltaPct', s.recent_market_signal_delta_pct,
          'confidenceStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
               and s.public_market_price is not null
                then 'HIGH'
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'QUARANTINED'
              when s.public_market_price is not null
                then 'LOW'
              else 'NONE'
            end,
          'publicInputStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'QUARANTINED'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                then 'INSUFFICIENT_PUBLIC_INPUT'
              when s.public_market_price is not null
                then 'SUPPORTED'
              else 'INSUFFICIENT_PUBLIC_INPUT'
            end,
          'priceConflictStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'INTERNAL_GUARDRAIL_DIVERGED'
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
                then 'CONSISTENT'
              when s.public_market_price is not null
                then 'PUBLIC_INPUT_ONLY'
              else 'NONE'
            end,
          'internalGuardrailStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED' then 'DIVERGED'
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 'CONSISTENT'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY' then 'PRIVATE_ONLY'
              else 'NOT_AVAILABLE'
            end,
          'priceAsOf', s.public_market_price_as_of,
          'movementHistorySource',
            case
              when s.public_market_price is not null
               and (s.public_change_pct_24h is not null or s.public_change_pct_7d is not null)
                then 'PERMITTED_MARKET_INPUT'
              else null
            end,
          'quarantineReason',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'PUBLIC_INPUT_DIVERGED_FROM_INTERNAL_GUARDRAIL'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                then 'MISSING_PERMITTED_PUBLIC_INPUT'
              when s.raw_market_price_outlier and s.public_market_price is null
                then 'PUBLIC_INPUT_OUTLIER_SUPPRESSED'
              else null
            end,
          'parityStatus',
            case
              when s.public_market_price is not null
               and (s.public_change_pct_24h is not null or s.public_change_pct_7d is not null)
               and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
                then 'MATCH'
              else 'MISSING_PROVIDER'
            end,
          'sourceMix',
            jsonb_build_object(
              'scrydexWeight',
                case when s.public_market_price is not null then 1 else 0 end,
              'publicInputWeight',
                case when s.public_market_price is not null then 1 else 0 end
            ),
          'sampleCounts7d',
            jsonb_build_object(
              'scrydex',
                case
                  when coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end,
              'public',
                case
                  when s.public_market_price is not null
                   and coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end
            )
        ))
      when s.raw_market_price_outlier then coalesce(s.market_provenance, '{}'::jsonb) || jsonb_build_object('parityStatus', 'MISSING_PROVIDER')
      else s.market_provenance
    end as public_market_provenance
  from public_display_policy s
)
select
  id,
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
  justtcg_price,
  case
    when is_en_raw and public_market_price is null then null
    when raw_market_price_outlier then null
    else coalesce(recent_market_signal_usd, scrydex_price)
  end as scrydex_price,
  case
    when is_en_raw and public_market_price is null then null
    when raw_market_price_outlier then null
    else coalesce(recent_market_signal_usd, scrydex_price)
  end as pokemontcg_price,
  yahoo_jp_price_out as yahoo_jp_price,
  yahoo_jp_price_jpy_out as yahoo_jp_price_jpy,
  yahoo_jp_sample_count_out as yahoo_jp_sample_count,
  yahoo_jp_observed_at_out as yahoo_jp_observed_at,
  snkrdunk_price_out as snkrdunk_price,
  snkrdunk_sample_count_out as snkrdunk_sample_count,
  snkrdunk_observed_at_out as snkrdunk_observed_at,
  snkrdunk_product_code_out as snkrdunk_product_code,
  public_market_price as market_price,
  public_market_price_as_of as market_price_as_of,
  public_provider_compare_as_of as provider_compare_as_of,
  public_confidence_score as market_confidence_score,
  public_low_confidence as market_low_confidence,
  public_market_blend_policy as market_blend_policy,
  public_market_provenance as market_provenance,
  public_change_pct_24h as change_pct_24h,
  public_change_pct_7d as change_pct_7d,
  updated_at,
  canonical_name_native,
  set_name_native,
  canonical_language as language,
  snkrdunk_price_jpy_out as snkrdunk_price_jpy,
  market_price_display_state,
  recent_market_signal_usd,
  recent_market_signal_as_of,
  recent_market_signal_delta_pct,
  recent_market_signal_direction,
  -- New columns MUST be appended last: CREATE OR REPLACE VIEW only allows
  -- adding trailing columns, not reordering existing ones.
  public_latest_price as latest_price,
  public_latest_price_as_of as latest_price_as_of
from public_provenance_policy;

grant select on public.public_card_metrics to anon, authenticated;
