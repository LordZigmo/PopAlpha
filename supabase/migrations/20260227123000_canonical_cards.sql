create table if not exists public.canonical_cards (
  slug text primary key,
  canonical_name text not null,
  subject text null,
  set_name text null,
  year int null,
  card_number text null,
  language text null,
  variant text null,
  created_at timestamptz not null default now()
);

create table if not exists public.card_aliases (
  id uuid primary key default gen_random_uuid(),
  alias text not null,
  canonical_slug text not null references public.canonical_cards(slug) on delete cascade,
  created_at timestamptz not null default now(),
  unique (alias, canonical_slug)
);

create index if not exists canonical_cards_canonical_name_idx
  on public.canonical_cards (canonical_name);

create index if not exists card_aliases_alias_idx
  on public.card_aliases (alias);

