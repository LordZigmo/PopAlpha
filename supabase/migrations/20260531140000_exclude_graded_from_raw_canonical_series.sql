-- Exclude graded variants from the RAW canonical price/change series.
--
-- Follow-up to 20260531120000. refresh_price_changes_core computes the RAW
-- canonical row's change_pct AND (since that migration) display_price from
-- base_points, which filtered price_history_points to the preferred printing by
-- printing-id (variant_ref segment 1) but did NOT exclude GRADED variants of
-- that printing (segment 3 = 'GRADED', e.g. <pid>::<v>::GRADED::PSA::G10::RAW).
-- provider_variant_match_score ties graded and ungraded, so on cards whose
-- preferred printing has only graded snapshots in the window (or where graded
-- won the price-proximity tiebreak), a GRADED price leaked into the RAW
-- headline (~68 EN cards shown, e.g. aquapolis-1-ampharos $25 from graded-only
-- points, brilliant-stars-174-charizard-vstar $241.62). This row is grade='RAW'
-- (canonical_scope filters grade='RAW'), so graded prices never belong here.
--
-- Fix: base_points now also requires split_part(variant_ref,'::',3) = 'RAW'
-- (ungraded only). Cards with no ungraded series get no display_price and fall
-- back to their prior basis via the public_card_metrics COALESCE, instead of
-- showing a graded price as the raw headline.
--
-- supersedes: 20260531120000_en_raw_chart_series_truth_display_price.sql
--             (refresh_price_changes_core: one added predicate in base_points;
--              every other line byte-for-byte identical, no column changes.)

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
      dv.display_change_pct_7d
    from canonical_scope cs
    left join latest_price lp using (canonical_slug)
    left join resolved_24h r24 using (canonical_slug)
    left join resolved_7d r7 using (canonical_slug)
    left join display_values dv using (canonical_slug)
  ),
  do_update as (
    update public.card_metrics cm
    set
      change_pct_24h = c.change_pct_24h,
      change_pct_7d = c.change_pct_7d,
      display_price = c.display_price,
      display_price_as_of = c.display_price_as_of,
      display_change_pct_24h = c.display_change_pct_24h,
      display_change_pct_7d = c.display_change_pct_7d
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
