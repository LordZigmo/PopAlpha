-- supersedes: 20260505040000_compute_daily_top_movers_relax_gate.sql
--
-- Switch the coverage gate from a single catalog-wide fresh_24h count
-- to a tier-aware coverage check. Reason: with the tiered-refresh model
-- shipped in Phases 1–4 (2026-05-06), a single fresh_24h threshold
-- conflates two unrelated questions —
--
--   (a) "is the pipeline alive?" — answerable from hot-tier freshness
--   (b) "do we have catalog breadth?" — answerable from warm-tier 7-day
--       freshness
--
-- Today the catalog is 1,526 hot + 9,193 warm + 8,938 sparse + 3,735
-- dormant = 23,392 cards (canonical_cards.refresh_tier). Real coverage:
--
--   hot   fresh_24h: ~669 / 1,526 (44%)
--   warm  fresh_7d:  ~8,876 / 9,193 (97%)
--   sparse fresh_7d: ~8,491 / 8,938 (95%)
--
-- The 15,000 fresh_24h threshold (relaxed from 18k in 20260505040000)
-- has been failing every cron tick today because most cards simply
-- don't trade every 24 hours — even hot cards average only ~44%
-- fresh_24h. The gate is measuring the wrong thing and the candidate
-- pool below already enforces the freshness it actually needs (24h
-- on each individual mover candidate).
--
-- New gate (both must be true):
--
--   p_hot_fresh_24h_threshold   default 500   (75% of current 669)
--   p_warm_fresh_7d_threshold   default 7500  (85% of current 8,876)
--
-- These are deliberately set just below current real coverage so a
-- meaningful pipeline regression trips the gate but normal-day
-- variance does not. Tighter than the catalog-wide gate ever was; the
-- earlier gate was tuning down to avoid frequent trips, which itself
-- was a sign the threshold was wrong.
--
-- Legacy parameter p_coverage_threshold is retained in the signature
-- for backward compatibility with any operator who supplies it; its
-- value is now ignored (logged in the response under
-- 'coverage_threshold_legacy_ignored'). All other behaviour identical
-- to 20260505040000 — body diffed line-by-line; only the gate query,
-- the early-return payload, and the success-payload metadata changed.
--
-- Stale-overload cleanup: pg_proc currently shows TWO overloads in
-- prod —
--
--   compute_daily_top_movers(int, int, int, int, numeric, int, numeric, int)               -- 8-arg, from 20260429010250_daily_top_movers_budget_tier
--   compute_daily_top_movers(int, int, int, int, numeric, int, numeric, numeric, int)      -- 9-arg, from 20260504230000_compute_daily_top_movers_mid_tier
--
-- because 20260504230000 added p_mid_min_price without dropping the
-- prior 8-arg overload. CREATE OR REPLACE FUNCTION cannot change the
-- argument list, so both have been coexisting and PostgREST's 0-arg
-- call site (`app/api/cron/compute-daily-top-movers/route.ts:84`) has
-- been resolving by ambiguous overload pick. Drop both before
-- creating the new 11-arg signature so only one definition remains.
drop function if exists public.compute_daily_top_movers(integer, integer, integer, integer, numeric, integer, numeric, integer);
drop function if exists public.compute_daily_top_movers(integer, integer, integer, integer, numeric, integer, numeric, numeric, integer);

create or replace function public.compute_daily_top_movers(
  p_coverage_threshold       integer default 15000,
  p_gainers_count            integer default 40,
  p_losers_count             integer default 40,
  p_max_per_set              integer default 2,
  p_min_change_pct           numeric default 2.5,
  p_momentum_count           integer default 40,
  p_premium_min_price        numeric default 50,
  p_mid_min_price            numeric default 8,
  p_budget_count             integer default 40,
  p_hot_fresh_24h_threshold  integer default 500,
  p_warm_fresh_7d_threshold  integer default 7500
)
returns jsonb
language plpgsql
security definer
set statement_timeout to '120s'
set search_path to 'public'
as $function$
declare
  _today                  date := (now() at time zone 'UTC')::date;
  _hot_fresh_24h          int;
  _warm_fresh_7d          int;
  _gainers_ins            int;
  _losers_ins             int;
  _momentum_24h_ins       int;
  _momentum_7d_ins        int;
  _mid_gainers_ins        int;
  _mid_losers_ins         int;
  _mid_momentum_24h_ins   int;
  _mid_momentum_7d_ins    int;
  _budget_gainers_ins     int;
  _max_change_pct         numeric := 75;
begin
  -- Tier-aware coverage gate. Hot cards are the pipeline-liveness
  -- signal (they should refresh daily); warm fresh_7d is the breadth
  -- signal (the bulk of the trading-active catalog).
  select count(*) into _hot_fresh_24h
  from public.public_card_metrics pcm
  join public.canonical_cards cc on cc.slug = pcm.canonical_slug
  where pcm.grade = 'RAW'
    and pcm.printing_id is null
    and pcm.market_price is not null
    and pcm.market_price_as_of > now() - interval '24 hours'
    and cc.refresh_tier = 'hot';

  select count(*) into _warm_fresh_7d
  from public.public_card_metrics pcm
  join public.canonical_cards cc on cc.slug = pcm.canonical_slug
  where pcm.grade = 'RAW'
    and pcm.printing_id is null
    and pcm.market_price is not null
    and pcm.market_price_as_of > now() - interval '7 days'
    and cc.refresh_tier = 'warm';

  if _hot_fresh_24h < p_hot_fresh_24h_threshold
     or _warm_fresh_7d < p_warm_fresh_7d_threshold then
    return jsonb_build_object(
      'computed', false,
      'reason', 'coverage_too_low',
      'hot_fresh_24h', _hot_fresh_24h,
      'warm_fresh_7d', _warm_fresh_7d,
      'hot_fresh_24h_threshold', p_hot_fresh_24h_threshold,
      'warm_fresh_7d_threshold', p_warm_fresh_7d_threshold,
      'coverage_threshold_legacy_ignored', p_coverage_threshold,
      'computed_at_date', _today
    );
  end if;

  delete from public.daily_top_movers where computed_at_date = _today;

  with candidates as (
    select
      pcm.canonical_slug,
      cc.set_name,
      pcm.market_price,
      pcm.market_price_as_of,
      pcm.active_listings_7d,
      pcm.market_confidence_score,
      pcm.change_pct_24h,
      pcm.change_pct_7d,
      coalesce(pcm.change_pct_24h, pcm.change_pct_7d) as change_pct,
      case when pcm.change_pct_24h is not null then '24H' else '7D' end as change_window,
      abs(coalesce(pcm.change_pct_24h, pcm.change_pct_7d)) *
        (coalesce(pcm.market_confidence_score, 0) / 100.0) *
        case
          when coalesce(pcm.active_listings_7d, 0) <= 1 then 0.35
          when coalesce(pcm.active_listings_7d, 0) <= 3 then 0.55
          when coalesce(pcm.active_listings_7d, 0) <= 5 then 0.75
          when coalesce(pcm.active_listings_7d, 0) <= 10 then 0.95
          when coalesce(pcm.active_listings_7d, 0) <= 20 then 1.1
          else 1.25
        end *
        case
          when cc.year >= 2025 then 2.5
          when cc.year >= 2023 then 1.5
          when cc.year >= 2020 then 1.2
          else 1.0
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
      and abs(coalesce(pcm.change_pct_24h, pcm.change_pct_7d)) <= _max_change_pct
  ),

  ----------------------------------------------------------------------------
  -- PREMIUM tier ($50+) — gainer / loser / momentum_24h / momentum_7d
  ----------------------------------------------------------------------------

  gainers_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct > 0
      and abs(c.change_pct) >= p_min_change_pct
      and c.market_price >= p_premium_min_price
  ),
  gainers_filtered as (
    select g.*, row_number() over (order by g.composite_score desc) as global_rank
    from gainers_eligible g
    where g.set_rank <= p_max_per_set
  ),
  gainers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'gainer', global_rank::int, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from gainers_filtered
    where global_rank <= p_gainers_count
    returning 1
  ),

  losers_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct < 0
      and abs(c.change_pct) >= p_min_change_pct
      and c.market_price >= p_premium_min_price
  ),
  losers_filtered as (
    select l.*, row_number() over (order by l.composite_score desc) as global_rank
    from losers_eligible l
    where l.set_rank <= p_max_per_set
  ),
  losers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'loser', global_rank::int, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from losers_filtered
    where global_rank <= p_losers_count
    returning 1
  ),

  momentum_24h_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct_24h is not null
      and c.change_pct_24h > 0
      and c.market_price >= p_premium_min_price
  ),
  momentum_24h_filtered as (
    select m.*, row_number() over (order by m.composite_score desc) as global_rank
    from momentum_24h_eligible m
    where m.set_rank <= p_max_per_set
  ),
  momentum_24h_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'momentum_24h', global_rank::int, canonical_slug,
      change_pct_24h, '24H',
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from momentum_24h_filtered
    where global_rank <= p_momentum_count
    returning 1
  ),

  momentum_7d_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct_7d is not null
      and c.change_pct_7d > 0
      and c.market_price >= p_premium_min_price
  ),
  momentum_7d_filtered as (
    select m.*, row_number() over (order by m.composite_score desc) as global_rank
    from momentum_7d_eligible m
    where m.set_rank <= p_max_per_set
  ),
  momentum_7d_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'momentum_7d', global_rank::int, canonical_slug,
      change_pct_7d, '7D',
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from momentum_7d_filtered
    where global_rank <= p_momentum_count
    returning 1
  ),

  ----------------------------------------------------------------------------
  -- MID tier ($8 ≤ p < $50) — gainer / loser / momentum_24h / momentum_7d
  ----------------------------------------------------------------------------

  mid_gainers_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct > 0
      and abs(c.change_pct) >= p_min_change_pct
      and c.market_price >= p_mid_min_price
      and c.market_price < p_premium_min_price
  ),
  mid_gainers_filtered as (
    select g.*, row_number() over (order by g.composite_score desc) as global_rank
    from mid_gainers_eligible g
    where g.set_rank <= p_max_per_set
  ),
  mid_gainers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'mid_gainer', global_rank::int, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from mid_gainers_filtered
    where global_rank <= p_gainers_count
    returning 1
  ),

  mid_losers_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct < 0
      and abs(c.change_pct) >= p_min_change_pct
      and c.market_price >= p_mid_min_price
      and c.market_price < p_premium_min_price
  ),
  mid_losers_filtered as (
    select l.*, row_number() over (order by l.composite_score desc) as global_rank
    from mid_losers_eligible l
    where l.set_rank <= p_max_per_set
  ),
  mid_losers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'mid_loser', global_rank::int, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from mid_losers_filtered
    where global_rank <= p_losers_count
    returning 1
  ),

  mid_momentum_24h_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct_24h is not null
      and c.change_pct_24h > 0
      and c.market_price >= p_mid_min_price
      and c.market_price < p_premium_min_price
  ),
  mid_momentum_24h_filtered as (
    select m.*, row_number() over (order by m.composite_score desc) as global_rank
    from mid_momentum_24h_eligible m
    where m.set_rank <= p_max_per_set
  ),
  mid_momentum_24h_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'mid_momentum_24h', global_rank::int, canonical_slug,
      change_pct_24h, '24H',
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from mid_momentum_24h_filtered
    where global_rank <= p_momentum_count
    returning 1
  ),

  mid_momentum_7d_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct_7d is not null
      and c.change_pct_7d > 0
      and c.market_price >= p_mid_min_price
      and c.market_price < p_premium_min_price
  ),
  mid_momentum_7d_filtered as (
    select m.*, row_number() over (order by m.composite_score desc) as global_rank
    from mid_momentum_7d_eligible m
    where m.set_rank <= p_max_per_set
  ),
  mid_momentum_7d_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'mid_momentum_7d', global_rank::int, canonical_slug,
      change_pct_7d, '7D',
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from mid_momentum_7d_filtered
    where global_rank <= p_momentum_count
    returning 1
  ),

  ----------------------------------------------------------------------------
  -- BUDGET tier ($1 ≤ p < $8) — gainer only
  ----------------------------------------------------------------------------

  budget_gainers_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct > 0
      and abs(c.change_pct) >= p_min_change_pct
      and c.market_price < p_mid_min_price
  ),
  budget_gainers_filtered as (
    select b.*, row_number() over (order by b.composite_score desc) as global_rank
    from budget_gainers_eligible b
    where b.set_rank <= p_max_per_set
  ),
  budget_gainers_ins as (
    insert into public.daily_top_movers (
      computed_at_date, kind, rank, canonical_slug, change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      confidence_score, composite_score
    )
    select _today, 'budget_gainer', global_rank::int, canonical_slug,
      change_pct, change_window,
      market_price, market_price_as_of, set_name, active_listings_7d,
      market_confidence_score, composite_score
    from budget_gainers_filtered
    where global_rank <= p_budget_count
    returning 1
  )
  select
    (select count(*) from gainers_ins),
    (select count(*) from losers_ins),
    (select count(*) from momentum_24h_ins),
    (select count(*) from momentum_7d_ins),
    (select count(*) from mid_gainers_ins),
    (select count(*) from mid_losers_ins),
    (select count(*) from mid_momentum_24h_ins),
    (select count(*) from mid_momentum_7d_ins),
    (select count(*) from budget_gainers_ins)
  into _gainers_ins, _losers_ins, _momentum_24h_ins, _momentum_7d_ins,
       _mid_gainers_ins, _mid_losers_ins, _mid_momentum_24h_ins, _mid_momentum_7d_ins,
       _budget_gainers_ins;

  return jsonb_build_object(
    'computed', true,
    'computed_at_date', _today,
    'hot_fresh_24h', _hot_fresh_24h,
    'warm_fresh_7d', _warm_fresh_7d,
    'hot_fresh_24h_threshold', p_hot_fresh_24h_threshold,
    'warm_fresh_7d_threshold', p_warm_fresh_7d_threshold,
    'coverage_threshold_legacy_ignored', p_coverage_threshold,
    'gainers_count', coalesce(_gainers_ins, 0),
    'losers_count', coalesce(_losers_ins, 0),
    'momentum_24h_count', coalesce(_momentum_24h_ins, 0),
    'momentum_7d_count', coalesce(_momentum_7d_ins, 0),
    'mid_gainers_count', coalesce(_mid_gainers_ins, 0),
    'mid_losers_count', coalesce(_mid_losers_ins, 0),
    'mid_momentum_24h_count', coalesce(_mid_momentum_24h_ins, 0),
    'mid_momentum_7d_count', coalesce(_mid_momentum_7d_ins, 0),
    'budget_gainers_count', coalesce(_budget_gainers_ins, 0),
    'max_per_set', p_max_per_set,
    'premium_min_price', p_premium_min_price,
    'mid_min_price', p_mid_min_price,
    'max_change_pct', _max_change_pct,
    'recency_weighting', '20260504220000',
    'tiering', '20260504230000',
    'coverage_gate', '20260506190000_tier_aware'
  );
end;
$function$;

-- Match the historical posture: the function is service-role-only.
-- The original 5-arg definer in 20260420031915_daily_top_movers.sql
-- did this; subsequent redefinitions stopped restating it. With the
-- prior overloads dropped above and only this 11-arg signature
-- remaining, restate the revoke explicitly so the surface stays
-- locked down.
revoke all on function public.compute_daily_top_movers(
  integer, integer, integer, integer, numeric, integer, numeric, numeric, integer, integer, integer
) from public, anon, authenticated;
