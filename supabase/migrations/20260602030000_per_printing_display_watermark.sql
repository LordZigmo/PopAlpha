-- Per-printing display refresh: bounded, watermark-paced (no more runaway).
--
-- Context: refresh_per_printing_raw_price_display recomputes latest_price +
-- 3-day-median display_price for per-printing RAW rows. Decoupled from the daily
-- price-change wrappers in 20260602020000 after it caused a 45-min runaway. A
-- standalone measurement showed ~27s per 5,000 rows (~5ms/row write; card_metrics
-- is wide+indexed) → a full ~49k-row pass is ~255s, too close to the cron ceiling
-- and growing. So this version is BOUNDED: a dedicated cron processes the N stalest
-- per-printing rows per tick (maxCards), stamps a watermark, and cycles through all
-- rows over a few ticks — the same pattern as refresh-card-translations.
--
-- Changes:
--   * card_metrics gains per_printing_display_refreshed_at (the watermark) + a
--     partial index to serve "stalest first" cheaply.
--   * The function signature changes from (text[] slugs) to (int p_max_cards):
--     p_max_cards NULL = all rows (one-shot/manual backfill); a number = the N
--     stalest rows. It stamps every scoped row so the cursor advances. The old
--     text[] overload had no callers (the wrappers were reverted) — dropped.
--
-- supersedes: 20260601120000_freshest_price_and_per_printing_display.sql
--             (refresh_per_printing_raw_price_display — same compute; adds
--              watermark scoping + stamp, changes the parameter to p_max_cards.)

alter table public.card_metrics
  add column if not exists per_printing_display_refreshed_at timestamptz;

-- "Stalest first" scan: nulls (never refreshed) then oldest. Partial — only the
-- per-printing RAW rows this function touches.
create index if not exists card_metrics_pp_display_refresh_idx
  on public.card_metrics (per_printing_display_refreshed_at asc nulls first)
  where grade = 'RAW' and printing_id is not null;

-- Old (text[] slugs) overload is orphaned since the wrapper revert (20260602020000).
drop function if exists public.refresh_per_printing_raw_price_display(text[]);

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
    returning 1
  )
  select count(*) into updated_count from do_update;

  return jsonb_build_object('pp_updated', updated_count);
end;
$$;

revoke all on function public.refresh_per_printing_raw_price_display(int) from public, anon, authenticated;
