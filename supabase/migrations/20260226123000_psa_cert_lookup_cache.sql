create table if not exists public.psa_cert_cache (
  cert text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists psa_cert_cache_fetched_at_idx
  on public.psa_cert_cache (fetched_at desc);

create table if not exists public.psa_cert_lookup_logs (
  id bigint generated always as identity primary key,
  cert text not null,
  cache_hit boolean not null,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists psa_cert_lookup_logs_cert_created_at_idx
  on public.psa_cert_lookup_logs (cert, created_at desc);
