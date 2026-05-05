-- supersedes: 20260504220000_compute_daily_top_movers_recency.sql
--
-- Three-tier price segmentation for the homepage rails.
--
-- Today there are only two tiers: premium (≥ $20) and budget ($1–$20).
-- The premium tier is overcrowded with $20–50 cards that aren't really
-- premium price-tier collectibles, and the budget tier is too wide to
-- give discoverable signal in either the $1–$8 chase-card band or the
-- $8–$50 mid market.
--
-- New segmentation:
--   premium  ≥ $50          (gainer / loser / momentum_24h / momentum_7d)
--   mid      $8 ≤ p < $50   (mid_gainer / mid_loser / mid_momentum_24h / mid_momentum_7d)
--   budget   $1 ≤ p < $8    (budget_gainer)
--
-- Eligibility filters unchanged. The `composite_score` formula
-- (including the 20260504220000 recency multiplier) is unchanged.
-- Only the price-band assignment and the 4 new mid_* rail kinds added.
--
-- Pool sizes verified before migration (2026-05-04 dry-run, 24h fresh
-- catalog, |change_pct| ≥ 2.5%):
--   premium: 38 gainers / 8 losers eligible
--   mid:    157 gainers / 30 losers eligible
--   budget: 477 gainers / 232 losers eligible
-- Premium loser rail will be thin — that's expected and OK; the rail
-- just renders fewer cards. The per-set diversity cap (max_per_set = 2)
-- still applies within each tier independently.
--
-- Returns object adds mid_*_count keys plus the new mid_min_price for
-- traceability. Cron logs and the audit harness can use these to
-- distinguish a tier-empty bug from "no signal" days.
--
-- Rollback: re-apply 20260504220000's body. The 4 new mid_* rail kinds
-- in daily_top_movers are forward-only (rows with kind='mid_gainer'
-- etc. would be orphaned but harmless since the homepage reads by
-- specific kind).

create or replace function public.compute_daily_top_movers(
  p_coverage_threshold  integer default 18000,
  p_gainers_count       integer default 40,
  p_losers_count        integer default 40,
  p_max_per_set         integer default 2,
  p_min_change_pct      numeric default 2.5,
  p_momentum_count      integer default 40,
  p_premium_min_price   numeric default 50,
  p_mid_min_price       numeric default 8,
  p_budget_count        integer default 40
)
returns jsonb
language plpgsql
security definer
set statement_timeout to '120s'
set search_path to 'public'
as $function$
declare
  _today                  date := (now() at time zone 'UTC')::date;
  _coverage_count         int;
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
    'coverage_count', _coverage_count,
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
    'tiering', '20260504230000'
  );
end;
$function$;
