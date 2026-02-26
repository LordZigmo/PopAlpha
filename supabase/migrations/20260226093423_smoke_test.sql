create table if not exists public.ingest_runs (
  id bigserial primary key,
  source text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'started',
  notes text
);

create index if not exists ingest_runs_started_at_idx
  on public.ingest_runs (started_at desc);