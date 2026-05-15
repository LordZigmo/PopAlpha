-- supersedes: 20260515181150_compute_daily_top_movers_warm_threshold.sql
--
-- Make compute_daily_top_movers warm_fresh_7d gate self-adjusting.
--
-- Background. The prior migration on 2026-05-15T18:11 set
-- p_warm_fresh_7d_threshold = 5000 as a hardcoded floor, fixing an
-- unhittable gate (the prior threshold of 7500 exceeded the entire
-- warm population). But hardcoded floors drift over time: the weekly
-- recompute-refresh-tier cron is reshaping the warm cohort, and the
-- population has fallen from 9,193 (2026-05-06) to 7,491 (2026-05-15)
-- in nine days. Two more weeks of similar drift would push the
-- population below 5,000 and re-strand the rails.
--
-- New behavior. p_warm_fresh_7d_threshold default is now NULL,
-- meaning 'auto'. In auto mode the function computes the effective
-- threshold each call as 65% of the current warm-tier population,
-- with a hard floor of 1000 to catch a catastrophic tier-classifier
-- wipe. An integer override (including 0) is still respected — useful
-- for operator-driven manual sweeps.
--
-- Why 65%? Today's warm coverage rate is ~79% (5,915 fresh / 7,491
-- total). A 65% gate sits 14 points below the steady-state rate:
--
--   65% gate trips when the rate drops by >14pp — i.e. an honest
--                pipeline-wide regression worth investigating.
--   18% margin today (gate=4,869 vs fresh=5,915) — wide enough that
--                normal day-to-day variance does not trip.
--
-- Tighter alternatives (70% leaves only 13% margin; 75% only 5%)
-- would trip on routine fluctuations.
--
-- Adaptation behavior:
--   * Population shrinks 20% → gate shrinks 20% too. Rate-based gate
--     remains achievable as the cohort settles.
--   * Population grows → gate grows. Catches gradual write-rate decay
--     a hardcoded floor would mask.
--   * Catastrophic pop ≤ ~1,500 → 1000 floor kicks in. Gate becomes
--     unhittable, intentionally — that population means the tier
--     classifier is broken.
--
-- Telemetry additions in the response payload:
--   * warm_fresh_7d_threshold        — the EFFECTIVE int used at gate-check time
--   * warm_fresh_7d_threshold_mode   — 'auto' | 'override'
--   * warm_population_total          — N at gate-check time
-- The cron route TypeScript shape is non-validating so the extra
-- fields are forward-compatible.
--
-- Backward-compat:
--   * Function signature unchanged in arg order/type — only the
--     default value of one parameter changes (5000 → NULL). PostgREST
--     resolution unaffected; the route call site
--     supabase.rpc('compute_daily_top_movers') passes no args and
--     reads the same response fields it already reads.
--   * Body is verbatim prod via pg_get_functiondef. Diff is the param
--     default, three new declared vars, the auto-compute block, the
--     gate-check var swap, two payload additions, and the
--     coverage_gate metadata tag.
--
-- Reversal: re-apply 20260515181150_compute_daily_top_movers_warm_threshold.sql
-- (which restores the integer 5000 default). No data migration.

CREATE OR REPLACE FUNCTION public.compute_daily_top_movers(p_coverage_threshold integer DEFAULT 15000, p_gainers_count integer DEFAULT 40, p_losers_count integer DEFAULT 40, p_max_per_set integer DEFAULT 2, p_min_change_pct numeric DEFAULT 2.5, p_momentum_count integer DEFAULT 40, p_premium_min_price numeric DEFAULT 50, p_mid_min_price numeric DEFAULT 8, p_budget_count integer DEFAULT 40, p_hot_fresh_24h_threshold integer DEFAULT 500, p_warm_fresh_7d_threshold integer DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '120s'
 SET search_path TO 'public'
AS $function$
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
  _warm_pop                int;
  _warm_threshold_effective int;
  _warm_threshold_mode      text;
begin
  -- Self-adjusting warm gate. NULL p_warm_fresh_7d_threshold means
  -- 'auto': compute as 65% of the current warm-tier population, with a
  -- safety floor of 1000 to catch a catastrophic tier-classifier wipe.
  -- Explicit integer override (including 0) wins.
  select count(*) into _warm_pop
  from public.canonical_cards
  where refresh_tier = 'warm';

  if p_warm_fresh_7d_threshold is not null then
    _warm_threshold_effective := p_warm_fresh_7d_threshold;
    _warm_threshold_mode := 'override';
  else
    _warm_threshold_effective := greatest(1000, (_warm_pop * 65 / 100));
    _warm_threshold_mode := 'auto';
  end if;


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
     or _warm_fresh_7d < _warm_threshold_effective then
    return jsonb_build_object(
      'computed', false,
      'reason', 'coverage_too_low',
      'hot_fresh_24h', _hot_fresh_24h,
      'warm_fresh_7d', _warm_fresh_7d,
      'hot_fresh_24h_threshold', p_hot_fresh_24h_threshold,
      'warm_fresh_7d_threshold', _warm_threshold_effective,
      'warm_fresh_7d_threshold_mode', _warm_threshold_mode,
      'warm_population_total', _warm_pop,
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
    'warm_fresh_7d_threshold', _warm_threshold_effective,
    'warm_fresh_7d_threshold_mode', _warm_threshold_mode,
    'warm_population_total', _warm_pop,
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
    'coverage_gate', '20260515183000_warm_threshold_auto_65pct'
  );
end;
$function$
