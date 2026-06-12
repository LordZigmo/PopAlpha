-- 20260612014500_refresh_price_changes_core_excludes_jp.sql
--
-- supersedes: 20260606140000_canonical_raw_headline_single_source.sql
--
-- Stop the EN change populator from clobbering JP-native change values.
--
-- BUG
-- ---
-- card_metrics.change_pct_24h / change_pct_7d on JP-language canonical RAW rows
-- have TWO uncoordinated writers:
--
--   * compute_jp_card_price_changes() (20260520140000) — the intended owner.
--     Computes JP-native deltas from jp_card_price_history (Yahoo JP +
--     Snkrdunk, JPY basis). Runs every 12h via refresh-card-metrics.
--   * refresh_price_changes_core() — the EN populator. Since 20260531120000
--     switched its `changes` CTE from "slugs that have EN points" to
--     `canonical_scope` (ALL printing_id IS NULL / grade='RAW' rows) with
--     LEFT JOINs, it produces a row for every canonical slug — including JP —
--     and the IS DISTINCT FROM update writes computed NULLs (no fresh Scrydex
--     points) or Scrydex-basis values (wrong basis: the US-reflection series,
--     ~100x off the displayed JP-native price) over the JP-native values.
--
-- The targeted wrapper path (refresh_price_changes_for_cards via
-- batch-refresh-pipeline-rollups, twice-hourly, fed by Scrydex ingests — JP
-- slugs mostly have Scrydex rows so they keep getting enqueued) out-calls the
-- 12-hourly JP populator ~500:1. Net effect measured in prod 2026-06-11:
-- 10.5h into a repair cycle, 592 of 3,092 JP slugs whose JP history supports a
-- 7d change held NULL; of the 3,027 JP rows with a 24h value, 1,685 had no JP
-- history in 14d — i.e. Scrydex-basis residue. JP cards showed a price with a
-- blank (or flapping, or wrong-basis) change badge.
--
-- FIX
-- ---
-- Partition the writers by language. canonical_scope now excludes slugs whose
-- canonical_cards.language = 'JP' — exactly the scope predicate
-- compute_jp_card_price_changes uses (join on canonical_cards.slug,
-- language = 'JP'), so the two writers partition cleanly with no gap and no
-- overlap: rows missing from canonical_cards (or with NULL language) stay
-- EN-managed, JP rows belong to the JP populator alone. The exclusion lives in
-- canonical_scope so both the full-scan path and the targeted
-- (p_canonical_slugs) wrapper path skip JP slugs, and the ~11k JP slugs with
-- incidental Scrydex rows also stop paying the point-scan cost here.
--
-- The body below is reproduced VERBATIM from 20260606140000; the ONLY change
-- is the `not exists` JP exclusion in canonical_scope (diff to confirm).
-- refresh_per_printing_raw_price_display is NOT redefined here — its latest
-- body remains 20260606140000. display_change_pct_* mirrored onto JP canonical
-- rows by that function never surfaces (public_card_metrics only uses the
-- display branch for EN-RAW), so it is left alone.
--
-- REPAIR
-- ------
-- One-shot compute_jp_card_price_changes() call at the end (same pattern as
-- 20260520140000's apply-time call): repopulates JP-native values wherever
-- jp_card_price_history supports them, and its stale-wipe branch nulls the
-- Scrydex-basis residue on JP rows with no qualifying JP history in 14d.
-- Without this, clobbered rows would wait up to 12h for the next
-- refresh-card-metrics tick. Bounded work (~13k JP canonical rows, ~40k
-- history rows in window) — safe at apply time.

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
      -- JP-language slugs are owned by compute_jp_card_price_changes()
      -- (20260520140000): same predicate it scopes by. Excluding them here
      -- (rather than in do_update) keeps both the full-scan and the targeted
      -- p_canonical_slugs paths from computing-then-writing NULL/Scrydex-basis
      -- values over the JP-native deltas.
      and not exists (
        select 1
        from public.canonical_cards cc
        where cc.slug = cm.canonical_slug
          and cc.language = 'JP'
      )
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
      -- Canonical headline (display_price / latest_price / display_change_pct_*) is
      -- NO LONGER written here -- refresh_per_printing_raw_price_display(int) mirrors
      -- it from the preferred printing as the single source of truth. Core keeps only
      -- change_pct_24h / change_pct_7d (a fallback used by public_card_metrics).
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

-- Belt-and-braces: CREATE OR REPLACE with an unchanged signature preserves the
-- existing ACL (lockdown from 20260318103000), but re-assert it anyway —
-- matches the 20260602020000 wrapper-revert precedent.
revoke all on function public.refresh_price_changes_core(text[]) from public, anon, authenticated;

-- One-shot repair (same apply-time pattern as 20260520140000): repopulate the
-- JP-native deltas the clobber nulled, and let the JP populator's stale-wipe
-- clear Scrydex-basis residue on JP rows with no qualifying JP history. After
-- this, every JP canonical RAW row holds either a JP-native change or NULL.
-- Known race: a mid-flight OLD-body full-scan core run committing after this
-- migration can re-clobber part of the repair from its pre-migration snapshot;
-- that self-heals at the next compute_jp tick (<=12h), and the post-merge
-- runbook for this PR re-runs compute_jp_card_price_changes() manually anyway.
select public.compute_jp_card_price_changes();
