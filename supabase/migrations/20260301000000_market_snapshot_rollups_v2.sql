-- Extend market_snapshot_rollups to include TCGPLAYER observations alongside
-- eBay observations so every card with a TCGPlayer price populates instead of
-- showing "Collecting". TCGPLAYER observations (written by the sync-tcg-prices
-- cron) represent the TCGPlayer market price for grade=RAW. eBay observations
-- continue to represent live ask data for all grades.
--
-- When a card has both EBAY and TCGPLAYER observations the median naturally
-- weights toward the larger sample (eBay) as observations accumulate. For
-- cards with only TCGPLAYER data (one observation per printing per day) the
-- median equals that day's market price, which is correct.

create or replace view public.market_snapshot_rollups as
with base as (
  select
    canonical_slug,
    printing_id,
    coalesce(grade, 'RAW') as grade,
    external_id as external_listing_id,
    price_value as price_usd,
    observed_at
  from public.listing_observations
  where source in ('EBAY', 'TCGPLAYER')
    and currency = 'USD'
    and price_value > 0
    and canonical_slug is not null
),
window_30d as (
  select
    canonical_slug,
    printing_id,
    grade,
    price_usd,
    observed_at,
    ntile(10) over (
      partition by canonical_slug, printing_id, grade
      order by price_usd asc
    ) as decile
  from base
  where observed_at >= now() - interval '30 days'
),
trimmed as (
  select
    canonical_slug,
    printing_id,
    grade,
    percentile_cont(0.5) within group (order by price_usd) as trimmed_median_30d
  from window_30d
  where decile between 2 and 9
  group by canonical_slug, printing_id, grade
)
select
  b.canonical_slug,
  b.printing_id,
  b.grade,
  count(distinct case when b.observed_at >= now() - interval '7 days' then b.external_listing_id end) as active_listings_7d,
  percentile_cont(0.5) within group (order by b.price_usd)
    filter (where b.observed_at >= now() - interval '7 days') as median_ask_7d,
  percentile_cont(0.5) within group (order by b.price_usd)
    filter (where b.observed_at >= now() - interval '30 days') as median_ask_30d,
  min(b.price_usd) filter (where b.observed_at >= now() - interval '30 days') as low_ask_30d,
  max(b.price_usd) filter (where b.observed_at >= now() - interval '30 days') as high_ask_30d,
  t.trimmed_median_30d
from base b
left join trimmed t
  on  t.canonical_slug = b.canonical_slug
  and t.printing_id is not distinct from b.printing_id
  and t.grade = b.grade
group by b.canonical_slug, b.printing_id, b.grade, t.trimmed_median_30d;
