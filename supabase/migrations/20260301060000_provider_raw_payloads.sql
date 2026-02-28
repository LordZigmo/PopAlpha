-- 20260301060000_provider_raw_payloads.sql
--
-- Stores complete raw API responses from external price providers.
-- One row per API call (e.g. one /sets call, one /cards?set=X call).
-- Useful for debugging, schema discovery, and replay without re-hitting the API.

create table if not exists public.provider_raw_payloads (
  id           uuid        primary key default gen_random_uuid(),
  provider     text        not null,       -- 'JUSTTCG', 'TCGPLAYER', 'EBAY'
  endpoint     text        not null,       -- '/sets', '/cards'
  params       jsonb       null,           -- query params used (setId, page, etc.)
  response     jsonb       not null,       -- full parsed response body
  status_code  integer     not null,
  fetched_at   timestamptz not null default now()
);

create index if not exists provider_raw_payloads_provider_idx
  on public.provider_raw_payloads (provider, fetched_at desc);

create index if not exists provider_raw_payloads_endpoint_idx
  on public.provider_raw_payloads (provider, endpoint, fetched_at desc);
