-- 20260606140000_canonical_raw_headline_single_source.sql
--
-- supersedes: 20260601120000_freshest_price_and_per_printing_display.sql
-- supersedes: 20260602030000_per_printing_display_watermark.sql
--
-- Single source of truth for the canonical RAW headline price.
--
-- BUG: the canonical (printing_id IS NULL, RAW) display_price / latest_price /
-- display_change_pct_* were computed off the POOLED canonical daily series, which
-- folds in a stale snapshot -> the homepage (canonical row) showed an inflated
-- number vs the detail (per-printing's clean series). N's Zoroark ex (Ascended
-- Heroes #286): canonical $192.25 vs the real per-printing close $190. Two functions
-- wrote the headline on decoupled crons, so it also drifted (#42).
--
-- FIX (both bodies reproduced VERBATIM from their latest definers; diff to confirm):
--   1. refresh_price_changes_core (from 20260601120000): STOP writing the canonical
--      display_price / display_price_as_of / latest_price / latest_price_as_of /
--      display_change_pct_*. Keeps change_pct_24h / change_pct_7d. (Now-unused display
--      CTEs left in place to keep the diff minimal.)
--   2. refresh_per_printing_raw_price_display(int) (from 20260602030000 -- the LIVE
--      watermark overload the production cron actually calls; the old text[] overload
--      is gone): after the bounded per-printing update, MIRROR the preferred printing's
--      display/latest onto the canonical RAW row, scoped to the slugs THIS tick
--      refreshed (stays bounded). This makes the per-printing function the SOLE writer
--      of the canonical headline -> one real number on both the homepage and the
--      detail, no drift. Extends task #52 (medians) to the live headline.
--
-- Data correction POST-MERGE via refresh_per_printing_raw_price_display(NULL) batches
-- (NOT in this migration -> avoids a long apply).

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
create or replace function public.refresh_per_printing_raw_price_display(p_max_cards int default null)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  mirror_count int := 0;
  v_batch_slugs text[];
  cutoff_14d timestamptz := now() - interval '14 days';
  cutoff_24h timestamptz := now() - interval '24 hours';
  cutoff_7d timestamptz := now() - interval '7 days';
  cutoff_3d timestamptz := now() - interval '3 days';
  cutoff_4d timestamptz := now() - interval '4 days';
  cutoff_10d timestamptz := now() - interval '10 days';
begin
  with pp_scope as (
    -- The N stalest per-printing RAW rows (NULL p_max_cards = all). The stamp at
    -- the end advances every scoped row out of the "stalest" window, so successive
    -- cron ticks cycle through the whole set.
    select cm.id as metric_id, cm.canonical_slug, cm.printing_id
    from public.card_metrics cm
    where cm.grade = 'RAW'
      and cm.printing_id is not null
      and cm.canonical_slug is not null
    order by cm.per_printing_display_refreshed_at asc nulls first, cm.id
    limit p_max_cards
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
    -- Write every scoped row (values from vals, NULL if no series) and stamp the
    -- watermark so it rotates out of the "stalest" window. No diff predicate: the
    -- stamp must advance on every scoped row, and the batch is bounded by p_max_cards.
    update public.card_metrics cm
    set
      display_price = v.display_price,
      display_price_as_of = v.display_price_as_of,
      latest_price = v.latest_price,
      latest_price_as_of = v.latest_price_as_of,
      display_change_pct_24h = v.display_change_pct_24h,
      display_change_pct_7d = v.display_change_pct_7d,
      per_printing_display_refreshed_at = now()
    from pp_scope s
    left join vals v on v.metric_id = s.metric_id
    where cm.id = s.metric_id
    returning cm.canonical_slug
  )
  select count(*), array_agg(distinct canonical_slug)
  into updated_count, v_batch_slugs
  from do_update;

  -- Canonical RAW headline = the preferred printing's clean value, mirrored ONLY for
  -- the slugs this watermark tick just refreshed (NOT all rows -> stays bounded like
  -- the per-printing update above). This int overload is the one the production cron
  -- calls, so the homepage canonical row stays in lockstep with the per-printing
  -- detail rows. Single source of truth: refresh_price_changes_core no longer writes
  -- the canonical headline. Extends task #52 (medians) to the live headline; #42.
  if v_batch_slugs is not null and array_length(v_batch_slugs, 1) > 0 then
    with canon_mirror as (
      update public.card_metrics canon
      set
        display_price = pref.display_price,
        display_price_as_of = pref.display_price_as_of,
        latest_price = pref.latest_price,
        latest_price_as_of = pref.latest_price_as_of,
        display_change_pct_24h = pref.display_change_pct_24h,
        display_change_pct_7d = pref.display_change_pct_7d
      from public.card_metrics pref
      where canon.printing_id is null
        and canon.grade = 'RAW'
        and canon.canonical_slug = any(v_batch_slugs)
        and pref.canonical_slug = canon.canonical_slug
        and pref.grade = 'RAW'
        and pref.printing_id = public.preferred_canonical_raw_printing(canon.canonical_slug)
        and pref.printing_id is not null
        and (
          canon.display_price is distinct from pref.display_price
          or canon.display_price_as_of is distinct from pref.display_price_as_of
          or canon.latest_price is distinct from pref.latest_price
          or canon.latest_price_as_of is distinct from pref.latest_price_as_of
          or canon.display_change_pct_24h is distinct from pref.display_change_pct_24h
          or canon.display_change_pct_7d is distinct from pref.display_change_pct_7d
        )
      returning 1
    )
    select count(*) into mirror_count from canon_mirror;
  end if;

  return jsonb_build_object('pp_updated', updated_count, 'canon_mirrored', mirror_count);
end;
$$;

revoke all on function public.refresh_per_printing_raw_price_display(int) from public, anon, authenticated;
