-- Durable provider-to-canonical mapping layer.
-- This is the authoritative mapping store for provider card identities.
-- provider_observation_matches remains an observation audit trail.

create table if not exists public.provider_card_map (
  id                uuid        primary key default gen_random_uuid(),
  provider          text        not null,
  provider_key      text        not null,
  asset_type        text        not null check (asset_type in ('single', 'sealed')),
  provider_set_id   text        null,
  provider_card_id  text        not null,
  provider_variant_id text      not null,
  canonical_slug    text        null references public.canonical_cards(slug) on delete set null,
  printing_id       uuid        null references public.card_printings(id) on delete set null,
  mapping_status    text        not null check (mapping_status in ('MATCHED', 'UNMATCHED')),
  match_type        text        null,
  match_confidence  numeric     null,
  match_reason      text        null,
  mapping_source    text        not null default 'PIPELINE'
    check (mapping_source in ('PIPELINE', 'OBSERVATION_MATCH', 'LEGACY_CARD_EXTERNAL_MAPPING', 'MANUAL')),
  metadata          jsonb       not null default '{}'::jsonb,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  last_observed_at  timestamptz null,
  last_matched_at   timestamptz null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists provider_card_map_provider_key_uidx
  on public.provider_card_map (provider, provider_key);

create unique index if not exists provider_card_map_provider_card_variant_uidx
  on public.provider_card_map (provider, provider_card_id, provider_variant_id);

create index if not exists provider_card_map_provider_status_idx
  on public.provider_card_map (provider, mapping_status, updated_at desc);

create index if not exists provider_card_map_provider_set_idx
  on public.provider_card_map (provider, provider_set_id, updated_at desc)
  where provider_set_id is not null;

create index if not exists provider_card_map_printing_idx
  on public.provider_card_map (printing_id, updated_at desc)
  where printing_id is not null;

create index if not exists provider_card_map_canonical_idx
  on public.provider_card_map (canonical_slug, updated_at desc)
  where canonical_slug is not null;

create or replace function public.provider_card_map_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_provider_card_map_set_updated_at on public.provider_card_map;
create trigger trg_provider_card_map_set_updated_at
before update on public.provider_card_map
for each row execute function public.provider_card_map_set_updated_at();

with observation_base as (
  select
    m.provider,
    (o.provider_card_id || '::' || o.provider_variant_id) as provider_key,
    o.asset_type,
    coalesce(m.provider_set_id, o.provider_set_id) as provider_set_id,
    o.provider_card_id,
    o.provider_variant_id,
    m.canonical_slug,
    m.printing_id,
    m.match_status as mapping_status,
    m.match_type,
    m.match_confidence,
    m.match_reason,
    coalesce(m.metadata, '{}'::jsonb) as metadata,
    o.observed_at,
    m.updated_at,
    coalesce(o.created_at, o.updated_at, o.observed_at, m.updated_at, m.created_at) as first_seen_at
  from public.provider_observation_matches m
  join public.provider_normalized_observations o
    on o.id = m.provider_normalized_observation_id
   and o.provider = m.provider
  where o.provider_card_id is not null
    and o.provider_variant_id is not null
),
observation_rollup as (
  select
    provider,
    provider_key,
    min(first_seen_at) as first_seen_at,
    max(coalesce(observed_at, updated_at, first_seen_at)) as last_seen_at,
    max(observed_at) as last_observed_at,
    max(case when mapping_status = 'MATCHED' then updated_at end) as last_matched_at
  from observation_base
  group by provider, provider_key
),
observation_best as (
  select *
  from (
    select
      ob.*,
      row_number() over (
        partition by ob.provider, ob.provider_key
        order by
          case when ob.mapping_status = 'MATCHED' then 0 else 1 end,
          coalesce(ob.match_confidence, 0) desc,
          coalesce(ob.updated_at, ob.observed_at, ob.first_seen_at) desc,
          ob.provider_card_id asc,
          ob.provider_variant_id asc
      ) as rn
    from observation_base ob
  ) ranked
  where rn = 1
)
insert into public.provider_card_map (
  provider,
  provider_key,
  asset_type,
  provider_set_id,
  provider_card_id,
  provider_variant_id,
  canonical_slug,
  printing_id,
  mapping_status,
  match_type,
  match_confidence,
  match_reason,
  mapping_source,
  metadata,
  first_seen_at,
  last_seen_at,
  last_observed_at,
  last_matched_at
)
select
  best.provider,
  best.provider_key,
  best.asset_type,
  best.provider_set_id,
  best.provider_card_id,
  best.provider_variant_id,
  best.canonical_slug,
  best.printing_id,
  best.mapping_status,
  best.match_type,
  best.match_confidence,
  best.match_reason,
  'OBSERVATION_MATCH',
  jsonb_build_object('backfilled_from', 'provider_observation_matches') || best.metadata,
  rollup.first_seen_at,
  rollup.last_seen_at,
  rollup.last_observed_at,
  rollup.last_matched_at
from observation_best best
join observation_rollup rollup
  on rollup.provider = best.provider
 and rollup.provider_key = best.provider_key
on conflict (provider, provider_key) do update
set
  asset_type = excluded.asset_type,
  provider_set_id = excluded.provider_set_id,
  provider_card_id = excluded.provider_card_id,
  provider_variant_id = excluded.provider_variant_id,
  canonical_slug = excluded.canonical_slug,
  printing_id = excluded.printing_id,
  mapping_status = excluded.mapping_status,
  match_type = excluded.match_type,
  match_confidence = excluded.match_confidence,
  match_reason = excluded.match_reason,
  mapping_source = excluded.mapping_source,
  metadata = excluded.metadata,
  first_seen_at = least(public.provider_card_map.first_seen_at, excluded.first_seen_at),
  last_seen_at = greatest(public.provider_card_map.last_seen_at, excluded.last_seen_at),
  last_observed_at = greatest(public.provider_card_map.last_observed_at, excluded.last_observed_at),
  last_matched_at = greatest(public.provider_card_map.last_matched_at, excluded.last_matched_at),
  updated_at = now();

with legacy_base as (
  select
    upper(btrim(cem.source)) as provider,
    case
      when coalesce(btrim(cem.meta->>'provider_card_id'), '') <> '' then btrim(cem.meta->>'provider_card_id')
      when coalesce(btrim(cem.card_id), '') <> '' then btrim(cem.card_id)
      else null
    end as provider_card_id,
    case
      when coalesce(btrim(cem.meta->>'provider_variant_id'), '') <> '' then btrim(cem.meta->>'provider_variant_id')
      when coalesce(btrim(cem.external_id), '') <> '' then btrim(cem.external_id)
      else null
    end as provider_variant_id,
    nullif(btrim(cem.meta->>'provider_set_id'), '') as provider_set_id,
    case
      when cem.canonical_slug like 'sealed:%' then 'sealed'
      else 'single'
    end as asset_type,
    cem.canonical_slug,
    cem.printing_id,
    case
      when cem.mapping_type = 'printing' then 'LEGACY_PRINTING'
      else 'LEGACY_CANONICAL'
    end as match_type,
    case
      when coalesce(cem.meta->>'match_confidence', '') ~ '^[0-9]+(\.[0-9]+)?$'
        then (cem.meta->>'match_confidence')::numeric
      else null
    end as match_confidence,
    coalesce(cem.meta, '{}'::jsonb) as metadata,
    coalesce(cem.created_at, now()) as created_at
  from public.card_external_mappings cem
  where upper(btrim(cem.source)) in ('JUSTTCG', 'SCRYDEX')
),
legacy_rows as (
  select
    provider,
    provider_card_id,
    provider_variant_id,
    (provider_card_id || '::' || provider_variant_id) as provider_key,
    asset_type,
    provider_set_id,
    canonical_slug,
    printing_id,
    match_type,
    match_confidence,
    metadata,
    created_at
  from legacy_base
  where provider_card_id is not null
    and provider_variant_id is not null
)
insert into public.provider_card_map (
  provider,
  provider_key,
  asset_type,
  provider_set_id,
  provider_card_id,
  provider_variant_id,
  canonical_slug,
  printing_id,
  mapping_status,
  match_type,
  match_confidence,
  match_reason,
  mapping_source,
  metadata,
  first_seen_at,
  last_seen_at,
  last_observed_at,
  last_matched_at
)
select
  provider,
  provider_key,
  asset_type,
  provider_set_id,
  provider_card_id,
  provider_variant_id,
  canonical_slug,
  printing_id,
  'MATCHED',
  match_type,
  match_confidence,
  null,
  'LEGACY_CARD_EXTERNAL_MAPPING',
  jsonb_build_object('backfilled_from', 'card_external_mappings') || metadata,
  created_at,
  created_at,
  null,
  created_at
from legacy_rows
on conflict (provider, provider_key) do nothing;
