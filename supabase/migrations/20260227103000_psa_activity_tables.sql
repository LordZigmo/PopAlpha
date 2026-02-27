create extension if not exists pgcrypto;

create table if not exists public.psa_cert_snapshots (
  id uuid primary key default gen_random_uuid(),
  cert text not null,
  fetched_at timestamptz not null default now(),
  source text not null,
  parsed jsonb not null,
  raw jsonb not null,
  hash text not null,
  unique (cert, hash)
);

create index if not exists psa_cert_snapshots_cert_fetched_at_idx
  on public.psa_cert_snapshots (cert, fetched_at desc);

create table if not exists public.market_events (
  id uuid primary key default gen_random_uuid(),
  asset_type text not null default 'psa_cert',
  asset_ref text not null,
  source text not null,
  event_type text not null,
  price numeric null,
  currency text default 'USD',
  occurred_at timestamptz not null default now(),
  metadata jsonb null
);

create index if not exists market_events_asset_ref_occurred_at_idx
  on public.market_events (asset_ref, occurred_at desc);
