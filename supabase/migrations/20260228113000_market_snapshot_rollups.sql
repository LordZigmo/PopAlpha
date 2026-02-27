alter table public.listing_observations
  alter column card_variant_id drop not null,
  add column if not exists canonical_slug text null,
  add column if not exists printing_id uuid null references public.card_printings(id) on delete set null,
  add column if not exists grade text null,
  add column if not exists url text null,
  add column if not exists raw jsonb not null default '{}'::jsonb;

create index if not exists listing_observations_canonical_grade_observed_at_idx
  on public.listing_observations (canonical_slug, grade, observed_at desc);

create index if not exists listing_observations_printing_grade_observed_at_idx
  on public.listing_observations (printing_id, grade, observed_at desc);

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
  where source = 'EBAY'
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
  on t.canonical_slug = b.canonical_slug
 and t.printing_id is not distinct from b.printing_id
 and t.grade = b.grade
group by b.canonical_slug, b.printing_id, b.grade, t.trimmed_median_30d;
