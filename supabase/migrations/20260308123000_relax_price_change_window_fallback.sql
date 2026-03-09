-- Relax canonical RAW price-change window selection:
-- 1. Keep exact 24h / 7d baseline buckets as the preferred source.
-- 2. If the exact bucket is missing, fall back to the nearest older baseline
--    instead of returning NULL immediately.
-- 3. Allow per-window fallback from provider window history (7d / 30d) even
--    when snapshot rows exist for the card, while still preferring snapshot
--    data whenever both are present.

create or replace function public.refresh_price_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  nulled_count  int := 0;
  cutoff_14d    timestamptz := now() - interval '14 days';
  cutoff_8d     timestamptz := now() - interval '8 days';
  cutoff_7d     timestamptz := now() - interval '7 days';
  cutoff_6d     timestamptz := now() - interval '6 days';
  cutoff_96h    timestamptz := now() - interval '96 hours';
  cutoff_36h    timestamptz := now() - interval '36 hours';
  cutoff_24h    timestamptz := now() - interval '24 hours';
begin
  with canonical_scope as (
    select cm.canonical_slug
    from public.card_metrics cm
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and cm.canonical_slug is not null
    group by cm.canonical_slug
  ),
  snapshot_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price,
      1::int as source_priority
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = 'snapshot'
      and ph.ts >= cutoff_14d
  ),
  provider_window_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price,
      case
        when ph.source_window = '7d' then 2
        else 3
      end::int as source_priority
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window in ('7d', '30d')
      and ph.ts >= cutoff_14d
  ),
  slugs_with_recent_snapshot as (
    select distinct canonical_slug
    from snapshot_points
    where ts >= cutoff_8d
  ),
  latest_points as (
    select
      sp.canonical_slug,
      sp.ts,
      sp.price,
      sp.source_priority
    from snapshot_points sp
    where sp.ts >= cutoff_8d

    union all

    select
      pwp.canonical_slug,
      pwp.ts,
      pwp.price,
      pwp.source_priority
    from provider_window_points pwp
    left join slugs_with_recent_snapshot s using (canonical_slug)
    where s.canonical_slug is null
      and pwp.ts >= cutoff_8d
  ),
  baseline_points as (
    select
      sp.canonical_slug,
      sp.ts,
      sp.price,
      sp.source_priority
    from snapshot_points sp

    union all

    select
      pwp.canonical_slug,
      pwp.ts,
      pwp.price,
      pwp.source_priority
    from provider_window_points pwp
  ),
  latest_hourly as (
    select
      lp.canonical_slug,
      date_trunc('hour', lp.ts) as bucket_ts,
      avg(lp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket,
      min(lp.source_priority)::integer as best_source_priority
    from latest_points lp
    group by lp.canonical_slug, date_trunc('hour', lp.ts)
  ),
  baseline_hourly as (
    select
      bp.canonical_slug,
      date_trunc('hour', bp.ts) as bucket_ts,
      avg(bp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket,
      min(bp.source_priority)::integer as best_source_priority
    from baseline_points bp
    group by bp.canonical_slug, date_trunc('hour', bp.ts)
  ),
  latest_price as (
    select distinct on (lh.canonical_slug)
      lh.canonical_slug,
      lh.canonical_price as price_now,
      lh.bucket_ts as latest_ts
    from latest_hourly lh
    order by lh.canonical_slug, lh.bucket_ts desc, lh.points_in_bucket desc, lh.best_source_priority asc
  ),
  price_exact_24h as (
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_24h,
      bh.bucket_ts as price_24h_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_36h and cutoff_24h
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      abs(extract(epoch from (bh.bucket_ts - cutoff_24h))) asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
  ),
  price_fallback_24h as (
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_24h,
      bh.bucket_ts as price_24h_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_96h and cutoff_24h
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
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
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_7d,
      bh.bucket_ts as price_7d_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_8d and cutoff_6d
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      abs(extract(epoch from (bh.bucket_ts - cutoff_7d))) asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
  ),
  price_fallback_7d as (
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_7d,
      bh.bucket_ts as price_7d_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_14d and cutoff_7d
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
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
      lp.canonical_slug,
      case
        when r24.price_24h is not null
          and r24.price_24h > 0
          and lp.latest_ts > cutoff_24h
          and r24.price_24h_ts < lp.latest_ts
        then ((lp.price_now - r24.price_24h) / r24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when r7.price_7d is not null
          and r7.price_7d > 0
          and r7.price_7d_ts < lp.latest_ts
        then ((lp.price_now - r7.price_7d) / r7.price_7d) * 100
        else null
      end as change_pct_7d
    from latest_price lp
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
    returning cm.id
  )
  select count(*) into updated_count from do_update;

  with canonical_scope as (
    select cm.canonical_slug
    from public.card_metrics cm
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and cm.canonical_slug is not null
    group by cm.canonical_slug
  ),
  slugs_with_history as (
    select distinct ph.canonical_slug
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window in ('snapshot', '7d', '30d')
      and ph.ts >= cutoff_14d
  ),
  do_null as (
    update public.card_metrics cm
    set
      change_pct_24h = null,
      change_pct_7d = null
    where cm.printing_id is null
      and cm.grade = 'RAW'
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
  nulled_count  int := 0;
  cutoff_14d    timestamptz := now() - interval '14 days';
  cutoff_8d     timestamptz := now() - interval '8 days';
  cutoff_7d     timestamptz := now() - interval '7 days';
  cutoff_6d     timestamptz := now() - interval '6 days';
  cutoff_96h    timestamptz := now() - interval '96 hours';
  cutoff_36h    timestamptz := now() - interval '36 hours';
  cutoff_24h    timestamptz := now() - interval '24 hours';
begin
  if p_canonical_slugs is null or coalesce(array_length(p_canonical_slugs, 1), 0) = 0 then
    return jsonb_build_object(
      'updated', 0,
      'nulled', 0
    );
  end if;

  with canonical_scope as (
    select distinct canonical_slug
    from unnest(p_canonical_slugs) as canonical_slug
    where canonical_slug is not null and trim(canonical_slug) <> ''
  ),
  snapshot_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price,
      1::int as source_priority
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = 'snapshot'
      and ph.ts >= cutoff_14d
  ),
  provider_window_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price,
      case
        when ph.source_window = '7d' then 2
        else 3
      end::int as source_priority
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window in ('7d', '30d')
      and ph.ts >= cutoff_14d
  ),
  slugs_with_recent_snapshot as (
    select distinct canonical_slug
    from snapshot_points
    where ts >= cutoff_8d
  ),
  latest_points as (
    select
      sp.canonical_slug,
      sp.ts,
      sp.price,
      sp.source_priority
    from snapshot_points sp
    where sp.ts >= cutoff_8d

    union all

    select
      pwp.canonical_slug,
      pwp.ts,
      pwp.price,
      pwp.source_priority
    from provider_window_points pwp
    left join slugs_with_recent_snapshot s using (canonical_slug)
    where s.canonical_slug is null
      and pwp.ts >= cutoff_8d
  ),
  baseline_points as (
    select
      sp.canonical_slug,
      sp.ts,
      sp.price,
      sp.source_priority
    from snapshot_points sp

    union all

    select
      pwp.canonical_slug,
      pwp.ts,
      pwp.price,
      pwp.source_priority
    from provider_window_points pwp
  ),
  latest_hourly as (
    select
      lp.canonical_slug,
      date_trunc('hour', lp.ts) as bucket_ts,
      avg(lp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket,
      min(lp.source_priority)::integer as best_source_priority
    from latest_points lp
    group by lp.canonical_slug, date_trunc('hour', lp.ts)
  ),
  baseline_hourly as (
    select
      bp.canonical_slug,
      date_trunc('hour', bp.ts) as bucket_ts,
      avg(bp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket,
      min(bp.source_priority)::integer as best_source_priority
    from baseline_points bp
    group by bp.canonical_slug, date_trunc('hour', bp.ts)
  ),
  latest_price as (
    select distinct on (lh.canonical_slug)
      lh.canonical_slug,
      lh.canonical_price as price_now,
      lh.bucket_ts as latest_ts
    from latest_hourly lh
    order by lh.canonical_slug, lh.bucket_ts desc, lh.points_in_bucket desc, lh.best_source_priority asc
  ),
  price_exact_24h as (
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_24h,
      bh.bucket_ts as price_24h_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_36h and cutoff_24h
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      abs(extract(epoch from (bh.bucket_ts - cutoff_24h))) asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
  ),
  price_fallback_24h as (
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_24h,
      bh.bucket_ts as price_24h_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_96h and cutoff_24h
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
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
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_7d,
      bh.bucket_ts as price_7d_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_8d and cutoff_6d
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      abs(extract(epoch from (bh.bucket_ts - cutoff_7d))) asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
  ),
  price_fallback_7d as (
    select distinct on (bh.canonical_slug)
      bh.canonical_slug,
      bh.canonical_price as price_7d,
      bh.bucket_ts as price_7d_ts
    from baseline_hourly bh
    where bh.bucket_ts between cutoff_14d and cutoff_7d
    order by
      bh.canonical_slug,
      bh.best_source_priority asc,
      bh.bucket_ts desc,
      bh.points_in_bucket desc
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
      lp.canonical_slug,
      case
        when r24.price_24h is not null
          and r24.price_24h > 0
          and lp.latest_ts > cutoff_24h
          and r24.price_24h_ts < lp.latest_ts
        then ((lp.price_now - r24.price_24h) / r24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when r7.price_7d is not null
          and r7.price_7d > 0
          and r7.price_7d_ts < lp.latest_ts
        then ((lp.price_now - r7.price_7d) / r7.price_7d) * 100
        else null
      end as change_pct_7d
    from latest_price lp
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
    returning cm.id
  )
  select count(*) into updated_count from do_update;

  with canonical_scope as (
    select distinct canonical_slug
    from unnest(p_canonical_slugs) as canonical_slug
    where canonical_slug is not null and trim(canonical_slug) <> ''
  ),
  slugs_with_history as (
    select distinct ph.canonical_slug
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window in ('snapshot', '7d', '30d')
      and ph.ts >= cutoff_14d
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
