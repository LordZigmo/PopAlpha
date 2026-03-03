create extension if not exists vector;

create table if not exists card_embeddings (
  canonical_slug text primary key,
  canonical_name text not null,
  subject text null,
  set_name text null,
  year integer null,
  card_number text null,
  variant text null,
  market_price double precision null,
  embedding vector(3072) not null,
  source_hash text not null,
  updated_at timestamptz not null default now()
);

drop index if exists card_embeddings_embedding_cosine_idx;

create index if not exists card_embeddings_set_name_idx
on card_embeddings (set_name);
