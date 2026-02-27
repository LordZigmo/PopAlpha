create table if not exists public.card_printings (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null references public.canonical_cards(slug) on delete cascade,
  set_name text null,
  set_code text null,
  year int null,
  card_number text not null,
  language text not null,
  finish text not null check (finish in ('NON_HOLO', 'HOLO', 'REVERSE_HOLO', 'ALT_HOLO', 'UNKNOWN')),
  finish_detail text null,
  edition text not null check (edition in ('UNLIMITED', 'FIRST_EDITION', 'UNKNOWN')),
  stamp text null,
  rarity text null,
  image_url text null,
  source text not null,
  source_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists card_printings_unique_printing_idx
  on public.card_printings (
    set_code,
    card_number,
    language,
    finish,
    edition,
    coalesce(stamp, ''),
    coalesce(finish_detail, '')
  );

create index if not exists card_printings_canonical_slug_idx
  on public.card_printings (canonical_slug);

create index if not exists card_printings_search_idx
  on public.card_printings (lower(set_name), lower(card_number), lower(language), lower(finish), lower(edition));

create table if not exists public.printing_aliases (
  alias text primary key,
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists printing_aliases_printing_id_idx
  on public.printing_aliases (printing_id);

create index if not exists printing_aliases_alias_lower_idx
  on public.printing_aliases ((lower(alias)));

create or replace function public.card_printings_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_card_printings_set_updated_at on public.card_printings;

create trigger trg_card_printings_set_updated_at
before update on public.card_printings
for each row execute function public.card_printings_set_updated_at();

