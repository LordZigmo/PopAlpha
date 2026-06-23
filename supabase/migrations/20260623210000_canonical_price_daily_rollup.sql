-- Portfolio sparkline daily-rollup: canonical_price_daily
--
-- Problem: /api/portfolio/overview builds the 30-day portfolio sparkline from
-- the public_price_history_canonical VIEW. The route's `ts >= now()-30d` bound
-- lands on the view's OUTPUT (a Subquery Scan filter), so the inner index scan
-- reads each slug's ALL-TIME history and evaluates the expensive per-row
-- predicates — preferred_canonical_raw_printing(slug) (a correlated LIMIT-1
-- subquery), the variant_ref regex, and the ::uuid cast — on every historical
-- row. Cold run ~14s; the route wraps it in `.data ?? []`, so a cold timeout
-- yields an EMPTY sparkline and the iOS chart stays hidden until the user
-- refreshes twice (warms the cache).
--
-- Fix: a pre-rolled table holding ONE RAW USD snapshot price per
-- (canonical_slug, day). The route reads it by (slug, day>=cutoff) — a bounded
-- index range scan, ms not seconds. refresh_canonical_price_daily() populates
-- it from price_history_points DIRECTLY with a HARD `ts >= now()-N days` bound
-- (the one thing the view can't push down), using the SAME filters + DISTINCT ON
-- tiebreak as public_price_history_canonical (migration 20260531150000), so the
-- rollup is value-for-value identical to what the view would have produced for
-- the same window — no sparkline numbers change.
--
-- PAIRED WITH the view def in 20260531150000_dedupe_canonical_price_history_chart.sql:
-- if that view's filters/preferred-printing logic ever change, the refresh body
-- below must change in lockstep or the rollup silently diverges.
--
-- supersedes: (new function — no prior definer)

-- 1) Rollup table. PK (canonical_slug, day) gives the natural one-row-per-day
--    dedup and serves the route's `slug IN (...) AND day >= cutoff` read.
create table if not exists public.canonical_price_daily (
  canonical_slug text        not null references public.canonical_cards(slug) on delete cascade,
  day            date        not null,                 -- UTC day bucket of ts
  price          numeric     not null,
  ts             timestamptz not null,                 -- exact ts of the chosen (latest-of-day) snapshot
  variant_ref    text        not null,                 -- provenance: which preferred-printing RAW variant won
  printing_id    uuid        not null,                 -- = preferred_canonical_raw_printing(slug) at refresh time
  refreshed_at   timestamptz not null default now(),
  primary key (canonical_slug, day)
);

comment on table public.canonical_price_daily is
  'One RAW USD snapshot price per (canonical_slug, day) for the portfolio sparkline. '
  'Pre-rolled from price_history_points by refresh_canonical_price_daily() using the '
  'same filters + DISTINCT ON tiebreak as the public_price_history_canonical view '
  '(20260531150000); kept in lockstep with that view. Retained ~40 days. Read by the '
  'anon route via the public_canonical_price_daily view; base table is service-role only.';

-- Explicit (the public-schema event trigger also enables it, but state it for
-- parity with the other service-role tables and so the table keeps RLS if that
-- trigger is ever removed). No policies + no anon grant = deny-by-default; the
-- anon client reads through the view, and refresh_canonical_price_daily is
-- SECURITY DEFINER so the writer bypasses RLS.
alter table public.canonical_price_daily enable row level security;

-- Trailing-window scan + retention prune both walk by day.
create index if not exists canonical_price_daily_day_idx
  on public.canonical_price_daily (day desc);

-- 2) Thin read surface for the anon route client. The base table stays
--    service-role-only; the view runs as its owner (bypassing base-table RLS),
--    mirroring how public_price_history_canonical exposes price_history_points.
create or replace view public.public_canonical_price_daily as
select canonical_slug, day, price
from public.canonical_price_daily;

-- 3) Incremental refresh. Reads price_history_points DIRECTLY (never the slow
--    view) with the index-bounded ts cutoff. SECURITY DEFINER so the cron's
--    service-role client populates a table the anon client can only read.
create or replace function public.refresh_canonical_price_daily(
  p_canonical_slugs text[] default null,
  p_days int default 35
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_upserted int := 0;
begin
  with src as (
    select distinct on (ph.canonical_slug, date_trunc('day', ph.ts))
      ph.canonical_slug,
      date_trunc('day', ph.ts)::date as day,
      ph.price,
      ph.ts,
      ph.variant_ref,
      ph.printing_id
    from public.price_history_points ph
    where ph.ts >= v_cutoff                          -- HARD ts bound: index-scannable, the whole point
      and ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window = 'snapshot'
      and ph.currency = 'USD'
      and ph.price > 0
      and ph.printing_id is not null
      and ph.variant_ref like '%::RAW'
      and ph.variant_ref not ilike '%::GRADED::%'
      and split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and split_part(ph.variant_ref, '::', 1)::uuid = ph.printing_id
      and ph.printing_id = public.preferred_canonical_raw_printing(ph.canonical_slug)
      and (p_canonical_slugs is null or ph.canonical_slug = any(p_canonical_slugs))
    order by
      ph.canonical_slug,
      date_trunc('day', ph.ts),
      abs(extract(epoch from (ph.created_at - ph.ts))) asc,   -- original same-day capture beats later backfill
      ph.ts desc                                              -- tie -> latest ts of the day
  ),
  upsert as (
    insert into public.canonical_price_daily
      (canonical_slug, day, price, ts, variant_ref, printing_id, refreshed_at)
    select s.canonical_slug, s.day, s.price, s.ts, s.variant_ref, s.printing_id, now()
    from src s
    on conflict (canonical_slug, day) do update set
      price        = excluded.price,
      ts           = excluded.ts,
      variant_ref  = excluded.variant_ref,
      printing_id  = excluded.printing_id,
      refreshed_at = excluded.refreshed_at
    where public.canonical_price_daily.price       is distinct from excluded.price
       or public.canonical_price_daily.ts          is distinct from excluded.ts
       or public.canonical_price_daily.variant_ref is distinct from excluded.variant_ref
       or public.canonical_price_daily.printing_id is distinct from excluded.printing_id
    returning 1
  )
  select count(*) into v_upserted from upsert;

  -- Retention: keep ~40 days (the route reads 30 + downsample headroom). Only on
  -- a full refresh — a targeted single-slug refresh shouldn't trigger a global
  -- prune scan.
  if p_canonical_slugs is null then
    delete from public.canonical_price_daily where day < (current_date - 40);
  end if;

  return jsonb_build_object('ok', true, 'upserted', v_upserted, 'days', p_days);
end;
$$;

-- 4) Grants. Table: service-role only. View: anon/authenticated read. Function:
--    service-role only — EXPLICITLY deny anon (new public functions get anon
--    EXECUTE by default as a direct grant, so a bare revoke-from-public would
--    leave anon able to run a SECURITY DEFINER writer).
revoke all     on table    public.canonical_price_daily from public, anon, authenticated;
grant  select, insert, update, delete on table public.canonical_price_daily to service_role;

grant  select  on public.public_canonical_price_daily to anon, authenticated;

revoke execute on function public.refresh_canonical_price_daily(text[], int) from public, anon, authenticated;
grant  execute on function public.refresh_canonical_price_daily(text[], int) to service_role;
