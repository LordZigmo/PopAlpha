create table if not exists public.cards (
  id text primary key,
  name text not null,
  set text not null,
  year int not null default 0,
  number text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cards
  add column if not exists image_url text null,
  add column if not exists rarity text null,
  add column if not exists supertype text null,
  add column if not exists subtypes text[] null,
  add column if not exists types text[] null,
  add column if not exists source_payload jsonb not null default '{}'::jsonb;

create table if not exists public.card_external_mappings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null references public.cards(id) on delete cascade,
  source text not null,
  mapping_type text not null,
  external_id text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists card_external_mappings_unique_idx
  on public.card_external_mappings (card_id, source, mapping_type);

create index if not exists card_external_mappings_external_id_idx
  on public.card_external_mappings (source, mapping_type, external_id);

create table if not exists public.card_variants (
  id uuid primary key default gen_random_uuid(),
  card_id text not null references public.cards(id) on delete cascade,
  variant_key text not null,
  finish text not null default 'UNKNOWN' check (finish in ('NON_HOLO', 'HOLO', 'REVERSE_HOLO', 'ALT_HOLO', 'UNKNOWN')),
  finish_detail text null,
  edition text not null default 'UNKNOWN' check (edition in ('UNLIMITED', 'FIRST_EDITION', 'UNKNOWN')),
  stamp text null,
  image_url text null,
  source text not null default 'pokemontcg',
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists card_variants_card_id_variant_key_idx
  on public.card_variants (card_id, variant_key);

create index if not exists card_variants_card_id_idx
  on public.card_variants (card_id);

create index if not exists card_variants_finish_idx
  on public.card_variants (finish);

create index if not exists card_variants_edition_idx
  on public.card_variants (edition);

create index if not exists card_variants_variant_key_idx
  on public.card_variants (variant_key);

create table if not exists public.label_normalization_rules (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'pokemontcg',
  match_type text not null check (match_type in ('variant_key', 'rarity', 'subtype', 'name_regex', 'set_regex')),
  match_value text not null,
  normalized_finish text not null check (normalized_finish in ('NON_HOLO', 'HOLO', 'REVERSE_HOLO', 'ALT_HOLO', 'UNKNOWN')),
  finish_detail text null,
  normalized_edition text null check (normalized_edition in ('UNLIMITED', 'FIRST_EDITION', 'UNKNOWN')),
  priority int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists label_normalization_rules_source_match_idx
  on public.label_normalization_rules (source, match_type, priority asc);

insert into public.label_normalization_rules
  (source, match_type, match_value, normalized_finish, normalized_edition, priority)
values
  ('pokemontcg', 'variant_key', 'normal', 'NON_HOLO', 'UNLIMITED', 10),
  ('pokemontcg', 'variant_key', 'holofoil', 'HOLO', 'UNLIMITED', 10),
  ('pokemontcg', 'variant_key', 'reverseHolofoil', 'REVERSE_HOLO', 'UNLIMITED', 10),
  ('pokemontcg', 'variant_key', '%1stEdition%', 'HOLO', 'FIRST_EDITION', 20),
  ('pokemontcg', 'variant_key', '*', 'ALT_HOLO', null, 900)
on conflict do nothing;

alter table public.ingest_runs
  add column if not exists job text,
  add column if not exists ok boolean not null default false,
  add column if not exists meta jsonb not null default '{}'::jsonb;

update public.ingest_runs
set job = coalesce(job, source)
where job is null;

