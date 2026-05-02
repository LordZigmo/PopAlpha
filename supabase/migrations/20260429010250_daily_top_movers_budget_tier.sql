-- 20260428030000_daily_top_movers_budget_tier.sql
--
-- Splits homepage signal rails by price tier so headline cards aren't crowded
-- out by cheap volatile bulk.
--
-- Existing rails (gainer / loser / momentum_24h / momentum_7d) now filter to
-- market_price >= p_premium_min_price (default $20).
--
-- A new 'budget_gainer' kind covers $1 <= price < $20 gainers, sourced from
-- the same candidate pool with the same composite score and set-diversity
-- capping.
--
-- The two tiers compute their own top-N independently so a thin premium pool
-- can't crowd out budget headlines and vice versa.

alter table public.daily_top_movers drop constraint if exists daily_top_movers_kind_check;
alter table public.daily_top_movers
  add constraint daily_top_movers_kind_check
  check (kind in ('gainer','loser','momentum_24h','momentum_7d','budget_gainer'));

drop function if exists public.compute_daily_top_movers(integer, integer, integer, integer, numeric, integer);

create or replace function public.compute_daily_top_movers(
  p_coverage_threshold  integer default 18000,
  p_gainers_count       integer default 40,
  p_losers_count        integer default 40,
  p_max_per_set         integer default 2,
  p_min_change_pct      numeric default 2.5,
  p_momentum_count      integer default 40,
  p_premium_min_price   numeric default 20,
  p_budget_count        integer default 40
)
returns jsonb
language plpgsql
security definer
set statement_timeout to '120s'
set search_path to 'public'
as $function$
declare
  _today              date := (now() at time zone 'UTC')::date;
  _coverage_count     int;
  _gainers_ins        int;
  _losers_ins         int;
  _momentum_24h_ins   int;
  _momentum_7d_ins    int;
  _budget_gainers_ins int;
begin
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
  ),
  -- Premium gainers ($20+)
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
  -- Premium losers ($20+)
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
  -- Premium momentum 24H ($20+)
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
  -- Premium momentum 7D ($20+)
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
  -- Budget gainers ($1 .. $20)
  budget_gainers_eligible as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct > 0
      and abs(c.change_pct) >= p_min_change_pct
      and c.market_price < p_premium_min_price
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
    (select count(*) from budget_gainers_ins)
  into _gainers_ins, _losers_ins, _momentum_24h_ins, _momentum_7d_ins, _budget_gainers_ins;

  return jsonb_build_object(
    'computed', true,
    'computed_at_date', _today,
    'coverage_count', _coverage_count,
    'gainers_count', coalesce(_gainers_ins, 0),
    'losers_count', coalesce(_losers_ins, 0),
    'momentum_24h_count', coalesce(_momentum_24h_ins, 0),
    'momentum_7d_count', coalesce(_momentum_7d_ins, 0),
    'budget_gainers_count', coalesce(_budget_gainers_ins, 0),
    'max_per_set', p_max_per_set,
    'premium_min_price', p_premium_min_price
  );
end;
$function$;
