create table if not exists public.psa_seed_certs (
  cert_no text primary key,
  enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.psa_certificates (
  cert_no text primary key,
  grade text,
  label text,
  year int,
  set_name text,
  subject text,
  variety text,
  image_url text,
  last_seen_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb
);

create index if not exists psa_certificates_last_seen_at_idx
  on public.psa_certificates (last_seen_at desc);

create index if not exists psa_certificates_grade_idx
  on public.psa_certificates (grade);

alter table public.ingest_runs
  add column if not exists items_fetched int not null default 0,
  add column if not exists items_upserted int not null default 0,
  add column if not exists items_failed int not null default 0,
  add column if not exists error_text text;
