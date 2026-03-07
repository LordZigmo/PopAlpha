-- Enforce non-null canonical RAW change outputs from refresh_price_changes().
-- Missing baselines now emit 0 instead of null, so UI surfaces can always render a percentage.

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
  zeroed_count  int := 0;
  cutoff_8d     timestamptz := now() - interval '8 days';
  cutoff_7d     timestamptz := now() - interval '7 days';
  cutoff_6d     timestamptz := now() - interval '6 days';
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
      ph.price
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    where ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = 'snapshot'
      and ph.ts >= cutoff_8d
  ),
  slugs_with_snapshot as (
    select distinct canonical_slug
    from snapshot_points
  ),
  fallback_30d_points as (
    select
      ph.canonical_slug,
      ph.ts,
      ph.price
    from public.price_history_points ph
    join canonical_scope cs using (canonical_slug)
    left join slugs_with_snapshot s using (canonical_slug)
    where s.canonical_slug is null
      and ph.provider in ('JUSTTCG', 'SCRYDEX')
      and ph.source_window = '30d'
      and ph.ts >= cutoff_8d
  ),
  recent_points as (
    select * from snapshot_points
    union all
    select * from fallback_30d_points
  ),
  canonical_hourly as (
    select
      rp.canonical_slug,
      date_trunc('hour', rp.ts) as bucket_ts,
      avg(rp.price)::numeric as canonical_price,
      count(*)::integer as points_in_bucket
    from recent_points rp
    group by rp.canonical_slug, date_trunc('hour', rp.ts)
  ),
  latest_price as (
    select distinct on (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price as price_now,
      ch.bucket_ts as latest_ts
    from canonical_hourly ch
    order by ch.canonical_slug, ch.bucket_ts desc, ch.points_in_bucket desc
  ),
  price_near_24h as (
    select distinct on (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price as price_24h,
      ch.bucket_ts as price_24h_ts
    from canonical_hourly ch
    where ch.bucket_ts between cutoff_36h and cutoff_24h
    order by
      ch.canonical_slug,
      abs(extract(epoch from (ch.bucket_ts - cutoff_24h))) asc,
      ch.bucket_ts desc,
      ch.points_in_bucket desc
  ),
  price_near_7d as (
    select distinct on (ch.canonical_slug)
      ch.canonical_slug,
      ch.canonical_price as price_7d,
      ch.bucket_ts as price_7d_ts
    from canonical_hourly ch
    where ch.bucket_ts between cutoff_8d and cutoff_6d
    order by
      ch.canonical_slug,
      abs(extract(epoch from (ch.bucket_ts - cutoff_7d))) asc,
      ch.bucket_ts desc,
      ch.points_in_bucket desc
  ),
  changes as (
    select
      lp.canonical_slug,
      case
        when p24.price_24h is not null
          and p24.price_24h > 0
          and lp.latest_ts > cutoff_24h
          and p24.price_24h_ts < lp.latest_ts
        then ((lp.price_now - p24.price_24h) / p24.price_24h) * 100
        else 0
      end as change_pct_24h,
      case
        when p7.price_7d is not null
          and p7.price_7d > 0
          and p7.price_7d_ts < lp.latest_ts
        then ((lp.price_now - p7.price_7d) / p7.price_7d) * 100
        else 0
      end as change_pct_7d
    from latest_price lp
    left join price_near_24h p24 using (canonical_slug)
    left join price_near_7d p7 using (canonical_slug)
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
      and ph.source_window in ('snapshot', '30d')
      and ph.ts >= cutoff_8d
  ),
  do_zero as (
    update public.card_metrics cm
    set
      change_pct_24h = 0,
      change_pct_7d = 0
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.change_pct_24h is distinct from 0
        or cm.change_pct_7d is distinct from 0
      )
      and not exists (
        select 1
        from slugs_with_history s
        where s.canonical_slug = cm.canonical_slug
      )
    returning cm.id
  )
  select count(*) into zeroed_count from do_zero;

  return jsonb_build_object(
    'updated', updated_count,
    'zeroed', zeroed_count
  );
end;
$$;

