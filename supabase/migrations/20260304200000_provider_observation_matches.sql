-- Provider-preserving match layer between normalized observations and our
-- canonical card identities. This records the match result only; price writes
-- happen later in a separate step.

create table if not exists public.provider_observation_matches (
  id                                 uuid        primary key default gen_random_uuid(),
  provider_normalized_observation_id uuid        not null references public.provider_normalized_observations(id) on delete cascade,
  provider                           text        not null,
  asset_type                         text        not null check (asset_type in ('single', 'sealed')),
  provider_set_id                    text        null,
  provider_card_id                   text        not null,
  provider_variant_id                text        not null,
  canonical_slug                     text        null references public.canonical_cards(slug) on delete set null,
  printing_id                        uuid        null references public.card_printings(id) on delete set null,
  match_status                       text        not null check (match_status in ('MATCHED', 'UNMATCHED')),
  match_type                         text        null,
  match_confidence                   numeric     null,
  match_reason                       text        null,
  metadata                           jsonb       not null default '{}'::jsonb,
  created_at                         timestamptz not null default now(),
  updated_at                         timestamptz not null default now()
);

create unique index if not exists provider_observation_matches_observation_uidx
  on public.provider_observation_matches (provider_normalized_observation_id);

create index if not exists provider_observation_matches_provider_status_idx
  on public.provider_observation_matches (provider, match_status, updated_at desc);

create index if not exists provider_observation_matches_provider_variant_idx
  on public.provider_observation_matches (provider, provider_variant_id);

create index if not exists provider_observation_matches_printing_idx
  on public.provider_observation_matches (printing_id, updated_at desc)
  where printing_id is not null;
