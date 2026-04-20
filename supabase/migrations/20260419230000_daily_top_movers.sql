-- 20260419230000_daily_top_movers.sql
--
-- Daily top-movers system.
--
-- Context: the homepage's "top movers" section was computed on every page
-- load from live public_card_metrics data. Two problems with that:
--   1. Same-set clustering: whichever set was just refreshed by Scrydex
--      dominated the list for a few hours, then rotated to another set.
--      Users saw different cards from the same set 3-5 times in the rail.
--   2. Empty-state on mid-cycle reads: when the pipeline was between
--      Scrydex daily chunks, recently-priced cards were few and the list
--      went sparse or empty.
--
-- User intent (2026-04-19): "top movers should be generated once daily
-- from a complete look at the cards. Only when we see 18,000 cards
-- priced for the day can we determine who the top movers are."
--
-- Architecture: a daily_top_movers table stores the day's ranked top
-- gainers and losers. A cron-driven RPC computes the list once per day
-- when catalog coverage is high enough, enforcing max-per-set diversity.
-- The homepage reads from this table instead of live data.

create table if not exists public.daily_top_movers (
  computed_at_date    date not null,
  kind                text not null check (kind in ('gainer', 'loser')),
  rank                int  not null,
  canonical_slug      text not null references public.canonical_cards(slug) on delete cascade,
  change_pct          numeric(10, 4) not null,
  change_window       text not null check (change_window in ('24H', '7D')),
  market_price        numeric(12, 4) not null,
  market_price_as_of  timestamptz not null,
  set_name            text,
  active_listings_7d  int,
  confidence_score    numeric(6, 2),
  composite_score     numeric(12, 6) not null,
  computed_at         timestamptz not null default now(),
  primary key (computed_at_date, kind, rank)
);

create index if not exists daily_top_movers_date_kind_idx
  on public.daily_top_movers (computed_at_date desc, kind);

create index if not exists daily_top_movers_slug_idx
  on public.daily_top_movers (canonical_slug);

alter table public.daily_top_movers enable row level security;

-- Anonymous read is fine — this is derived from public_card_metrics which
-- is already read by the (unauthenticated) homepage.
drop policy if exists daily_top_movers_public_read on public.daily_top_movers;
create policy daily_top_movers_public_read
  on public.daily_top_movers
  for select
  using (true);

-- ── compute_daily_top_movers() ──────────────────────────────────────────────
--
-- Idempotent — replaces today's rows on each call. Safe to run hourly from
-- a cron. Returns a summary jsonb.
--
-- Criteria (must satisfy all):
--   - market_price >= 1
--   - market_price_as_of within last 24h
--   - snapshot_count_30d >= 27  (near-daily coverage)
--   - market_confidence_score >= 45
--   - NOT market_low_confidence
--   - change_pct (24h preferred, 7d fallback) exists and magnitude >= 2.5%
--
-- Coverage gate: if the number of mover-eligible cards (above criteria,
-- ignoring the change threshold) is below p_coverage_threshold, the
-- function returns {computed: false, reason: 'coverage_too_low'} without
-- touching the table. Homepage then falls back to yesterday's row or empty.
--
-- Set diversity: window function partitions the candidate pool by set_name
-- and keeps only top p_max_per_set per set, ensuring the final list
-- doesn't cluster in one or two sets.

create or replace function public.compute_daily_top_movers(
  p_coverage_threshold  int default 18000,
  p_gainers_count       int default 40,
  p_losers_count        int default 40,
  p_max_per_set         int default 2,
  p_min_change_pct      numeric default 2.5
)
returns jsonb
language plpgsql
security definer
set statement_timeout = '120s'
set search_path = public
as $$
declare
  _today          date := (now() at time zone 'UTC')::date;
  _coverage_count int;
  _gainers_ins    int;
  _losers_ins     int;
begin
  -- Coverage gate: count catalog-wide fresh_24h (not filtered by price).
  -- User intent: "only when we see 18,000 cards priced for the day can we
  -- determine who the top movers are". This is about completeness of the
  -- catalog-wide Scrydex poll, not about mover candidates specifically.
  select count(*) into _coverage_count
  from public.public_card_metrics pcm
  where pcm.grade = 'RAW'
    and pcm.printing_id is null
    and pcm.market_price is not null
    and pcm.market_price_as_of > now() - interval '24 hours';

  if _coverage_count < p_coverage_threshold then
    return jsonb_build_object(
      'computed', false,
      'reason', 'coverage_too_low',
      'coverage_count', _coverage_count,
      'threshold', p_coverage_threshold,
      'computed_at_date', _today
    );
  end if;

  -- Replace today's rows.
  delete from public.daily_top_movers where computed_at_date = _today;

  -- Shared candidate CTE
  with candidates as (
    select
      pcm.canonical_slug,
      cc.set_name,
      pcm.market_price,
      pcm.market_price_as_of,
      pcm.active_listings_7d,
      pcm.market_confidence_score,
      -- Prefer 24h if present, else 7d
      coalesce(pcm.change_pct_24h, pcm.change_pct_7d) as change_pct,
      case when pcm.change_pct_24h is not null then '24H' else '7D' end as change_window,
      -- Composite score: |change_pct| × (confidence/100) × liquidity_weight
      abs(coalesce(pcm.change_pct_24h, pcm.change_pct_7d)) *
        (coalesce(pcm.market_confidence_score, 0) / 100.0) *
        case
          when coalesce(pcm.active_listings_7d, 0) <= 1 then 0.35
          when coalesce(pcm.active_listings_7d, 0) <= 3 then 0.55
          when coalesce(pcm.active_listings_7d, 0) <= 5 then 0.75
          when coalesce(pcm.active_listings_7d, 0) <= 10 then 0.95
          when coalesce(pcm.active_listings_7d, 0) <= 20 then 1.1
          else 1.25
        end as composite_score
    from public.public_card_metrics pcm
    join public.canonical_cards cc on cc.slug = pcm.canonical_slug
    where pcm.grade = 'RAW'
      and pcm.printing_id is null
      and pcm.market_price >= 1
      and pcm.market_price_as_of > now() - interval '24 hours'
      and pcm.snapshot_count_30d >= 27
      and pcm.market_confidence_score >= 45
      and (pcm.market_low_confidence is null or pcm.market_low_confidence = false)
      and coalesce(pcm.change_pct_24h, pcm.change_pct_7d) is not null
      and abs(coalesce(pcm.change_pct_24h, pcm.change_pct_7d)) >= p_min_change_pct
  ),
  -- Gainers: positive change, rank by composite desc, cap per set, take top N
  gainers_all as (
    select
      c.*,
      row_number() over (
        partition by c.set_name
        order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct > 0
  ),
  gainers_filtered as (
    select
      g.*,
      row_number() over (order by g.composite_score desc) as global_rank
    from gainers_all g
    where g.set_rank <= p_max_per_set
  ),
  gainers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select
      _today, 'gainer', global_rank::int, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from gainers_filtered
    where global_rank <= p_gainers_count
    returning 1
  ),
  -- Losers: mirror of gainers, change_pct < 0
  losers_all as (
    select
      c.*,
      row_number() over (
        partition by c.set_name
        order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct < 0
  ),
  losers_filtered as (
    select
      l.*,
      row_number() over (order by l.composite_score desc) as global_rank
    from losers_all l
    where l.set_rank <= p_max_per_set
  ),
  losers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select
      _today, 'loser', global_rank::int, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from losers_filtered
    where global_rank <= p_losers_count
    returning 1
  )
  select
    (select count(*) from gainers_ins),
    (select count(*) from losers_ins)
  into _gainers_ins, _losers_ins;

  return jsonb_build_object(
    'computed', true,
    'computed_at_date', _today,
    'coverage_count', _coverage_count,
    'gainers_count', coalesce(_gainers_ins, 0),
    'losers_count', coalesce(_losers_ins, 0),
    'max_per_set', p_max_per_set
  );
end;
$$;

revoke all on function public.compute_daily_top_movers(int, int, int, int, numeric)
  from public, anon, authenticated;
