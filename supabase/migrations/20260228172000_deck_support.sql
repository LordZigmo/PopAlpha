create table if not exists public.decks (
  id text primary key,
  name text not null,
  format text null,
  release_year int null,
  source text not null default 'pokemon-tcg-data',
  source_id text null,
  image_url text null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deck_cards (
  deck_id text not null references public.decks(id) on delete cascade,
  card_source text not null default 'pokemon-tcg-data',
  card_source_id text not null,
  qty int not null check (qty > 0),
  primary key (deck_id, card_source, card_source_id)
);

create table if not exists public.deck_aliases (
  alias text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists decks_name_tsv_idx
  on public.decks
  using gin (to_tsvector('simple', coalesce(name, '')));

create index if not exists deck_cards_source_id_idx
  on public.deck_cards (card_source, card_source_id);

create index if not exists deck_aliases_deck_id_idx
  on public.deck_aliases (deck_id);

create or replace function public.decks_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_decks_set_updated_at on public.decks;

create trigger trg_decks_set_updated_at
before update on public.decks
for each row execute function public.decks_set_updated_at();
