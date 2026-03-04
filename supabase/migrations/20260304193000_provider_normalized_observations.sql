-- Normalize raw provider payloads into provider-agnostic staged observations.
-- One row per provider card variant per raw payload snapshot.
-- This is the intermediate layer between raw fetch storage and future matching.

create table if not exists public.provider_normalized_observations (
  id                      uuid        primary key default gen_random_uuid(),
  provider_raw_payload_id uuid        not null references public.provider_raw_payloads(id) on delete cascade,
  provider                text        not null,
  endpoint                text        not null,
  provider_set_id         text        null,
  provider_card_id        text        not null,
  provider_variant_id     text        not null,
  asset_type              text        not null check (asset_type in ('single', 'sealed')),
  set_name                text        null,
  card_name               text        not null,
  card_number             text        null,
  card_number_normalized  text        null,
  provider_finish         text        null,
  normalized_finish       text        not null check (normalized_finish in ('NON_HOLO', 'HOLO', 'REVERSE_HOLO', 'UNKNOWN')),
  provider_condition      text        null,
  normalized_condition    text        not null,
  provider_language       text        null,
  variant_ref             text        not null,
  price_value             numeric     null,
  currency                text        not null default 'USD',
  observed_at             timestamptz not null,
  history_points_30d      jsonb       not null default '[]'::jsonb,
  history_points_30d_count integer    not null default 0,
  metadata                jsonb       not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index if not exists provider_normalized_observations_payload_variant_uidx
  on public.provider_normalized_observations (provider_raw_payload_id, provider_card_id, provider_variant_id);

create index if not exists provider_normalized_observations_provider_observed_idx
  on public.provider_normalized_observations (provider, observed_at desc);

create index if not exists provider_normalized_observations_provider_set_idx
  on public.provider_normalized_observations (provider, provider_set_id, observed_at desc)
  where provider_set_id is not null;

create index if not exists provider_normalized_observations_variant_ref_idx
  on public.provider_normalized_observations (provider, variant_ref, observed_at desc);
