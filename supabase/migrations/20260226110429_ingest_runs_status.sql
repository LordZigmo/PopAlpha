alter table public.ingest_runs
  add column if not exists status text not null default 'started',
  add column if not exists ended_at timestamptz,
  add column if not exists notes text;

create index if not exists ingest_runs_status_idx
  on public.ingest_runs (status);

create index if not exists ingest_runs_ended_at_idx
  on public.ingest_runs (ended_at desc);