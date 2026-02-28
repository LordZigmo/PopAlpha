alter table public.canonical_cards
  add column if not exists search_doc text not null default '',
  add column if not exists search_doc_norm text not null default '';

alter table public.card_aliases
  add column if not exists alias_norm text not null default '';

create index if not exists canonical_cards_search_doc_norm_idx
  on public.canonical_cards (search_doc_norm);

create index if not exists card_aliases_alias_norm_idx
  on public.card_aliases (alias_norm);
