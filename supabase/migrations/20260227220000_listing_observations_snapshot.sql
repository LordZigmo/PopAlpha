create table if not exists public.listing_observations (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null,
  card_variant_id uuid not null references public.card_variants(id) on delete cascade,
  title text not null,
  price_value numeric not null,
  currency text not null,
  shipping_value numeric null,
  condition text null,
  seller text null,
  observed_at timestamptz not null default now()
);

create unique index if not exists listing_observations_source_external_id_idx
  on public.listing_observations (source, external_id);

create index if not exists listing_observations_variant_observed_at_idx
  on public.listing_observations (card_variant_id, observed_at desc);

create or replace view public.market_snapshot as
with base as (
  select
    card_variant_id,
    external_id,
    price_value,
    observed_at
  from public.listing_observations
  where currency = 'USD'
    and price_value > 0
),
ranked_30d as (
  select
    card_variant_id,
    price_value,
    ntile(10) over (partition by card_variant_id order by price_value asc) as decile
  from base
  where observed_at >= now() - interval '30 days'
),
trimmed_30d as (
  select
    card_variant_id,
    percentile_cont(0.5) within group (order by price_value) as trimmed_median_30d
  from ranked_30d
  where decile between 2 and 9
  group by card_variant_id
)
select
  b.card_variant_id,
  count(distinct case when b.observed_at >= now() - interval '7 days' then b.external_id end) as active_listing_count,
  percentile_cont(0.5) within group (order by b.price_value)
    filter (where b.observed_at >= now() - interval '7 days') as median_price_7d,
  percentile_cont(0.5) within group (order by b.price_value)
    filter (where b.observed_at >= now() - interval '30 days') as median_price_30d,
  t.trimmed_median_30d
from base b
left join trimmed_30d t on t.card_variant_id = b.card_variant_id
group by b.card_variant_id, t.trimmed_median_30d;

