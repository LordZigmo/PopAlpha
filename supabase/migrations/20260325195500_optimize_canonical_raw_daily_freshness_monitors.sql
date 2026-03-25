create index if not exists price_history_points_snapshot_window_ts_slug_idx
  on public.price_history_points (source_window, ts desc, canonical_slug)
  where source_window = 'snapshot';

create or replace function public.get_canonical_raw_daily_freshness_monitors(p_window_days integer[])
returns table (
  window_days integer,
  window_hours integer,
  as_of timestamptz,
  cutoff_iso timestamptz,
  total_canonical_raw bigint,
  fresh_canonical_raw bigint,
  fresh_pct numeric
)
language sql
stable
as $$
  with normalized_windows as (
    select distinct greatest(coalesce(window_day, 1), 1)::integer as window_days
    from unnest(
      case
        when coalesce(array_length(p_window_days, 1), 0) = 0 then array[7, 30, 90]::integer[]
        else p_window_days
      end
    ) as window_day
  ),
  bounds as (
    select
      now() as as_of,
      timezone('UTC', now())::date as as_of_date,
      ((timezone('UTC', now())::date - (max(window_days) - 1))::timestamp at time zone 'UTC') as first_day_start_utc
    from normalized_windows
  ),
  raw_cards as (
    select distinct canonical_slug
    from public.public_card_metrics
    where grade = 'RAW'
      and printing_id is null
  ),
  raw_daily_coverage as (
    select
      pph.canonical_slug,
      (pph.ts at time zone 'UTC')::date as price_day
    from public.public_price_history pph
    join bounds b
      on pph.ts >= b.first_day_start_utc
     and pph.ts < (b.as_of_date + 1)::timestamp at time zone 'UTC'
    where pph.source_window = 'snapshot'
    group by pph.canonical_slug, (pph.ts at time zone 'UTC')::date
  ),
  window_coverage as (
    select
      nw.window_days,
      rdc.canonical_slug,
      count(*)::integer as covered_days
    from normalized_windows nw
    join bounds b on true
    join raw_daily_coverage rdc
      on rdc.price_day between (b.as_of_date - (nw.window_days - 1)) and b.as_of_date
    join raw_cards rc
      on rc.canonical_slug = rdc.canonical_slug
    group by nw.window_days, rdc.canonical_slug
  ),
  total_raw as (
    select count(*)::bigint as total_canonical_raw
    from raw_cards
  ),
  fresh_counts as (
    select
      nw.window_days,
      coalesce(count(*) filter (where wc.covered_days >= nw.window_days), 0)::bigint as fresh_canonical_raw
    from normalized_windows nw
    left join window_coverage wc
      on wc.window_days = nw.window_days
    group by nw.window_days
  )
  select
    nw.window_days,
    nw.window_days * 24 as window_hours,
    b.as_of,
    ((b.as_of_date - (nw.window_days - 1))::timestamp at time zone 'UTC') as cutoff_iso,
    tr.total_canonical_raw,
    fc.fresh_canonical_raw,
    case
      when tr.total_canonical_raw > 0
        then round((fc.fresh_canonical_raw::numeric / tr.total_canonical_raw::numeric) * 100, 2)
      else 0::numeric
    end as fresh_pct
  from normalized_windows nw
  cross join bounds b
  cross join total_raw tr
  join fresh_counts fc
    on fc.window_days = nw.window_days
  order by nw.window_days;
$$;

grant execute on function public.get_canonical_raw_daily_freshness_monitors(integer[]) to anon, authenticated;
