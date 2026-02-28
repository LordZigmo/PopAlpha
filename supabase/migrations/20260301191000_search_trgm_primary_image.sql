-- search_doc_norm / alias_norm are queried with `%token%` contains matches,
-- so btree is not enough. pg_trgm GIN indexes make those contains filters
-- viable at production scale.

create extension if not exists pg_trgm;

alter table public.canonical_cards
  add column if not exists primary_image_url text null;

create index if not exists canonical_cards_search_doc_norm_trgm_idx
  on public.canonical_cards using gin (search_doc_norm gin_trgm_ops);

create index if not exists card_aliases_alias_norm_trgm_idx
  on public.card_aliases using gin (alias_norm gin_trgm_ops);
