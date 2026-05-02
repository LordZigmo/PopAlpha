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

  delete from public.daily_top_movers where computed_at_date = _today;

  with candidates as (
    select
      pcm.canonical_slug,
      cc.set_name,
      pcm.market_price,
      pcm.market_price_as_of,
      pcm.active_listings_7d,
      pcm.market_confidence_score,
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
      and abs(coalesce(pcm.change_pct_24h, pcm.change_pct_7d)) >= p_min_change_pct
  ),
  gainers_all as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct > 0
  ),
  gainers_filtered as (
    select g.*, row_number() over (order by g.composite_score desc) as global_rank
    from gainers_all g
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
  losers_all as (
    select c.*, row_number() over (
        partition by c.set_name order by c.composite_score desc
      ) as set_rank
    from candidates c
    where c.change_pct < 0
  ),
  losers_filtered as (
    select l.*, row_number() over (order by l.composite_score desc) as global_rank
    from losers_all l
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
  )
  select (select count(*) from gainers_ins), (select count(*) from losers_ins)
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
