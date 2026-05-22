-- RECOVERY MIGRATION — fourth occurrence of the documented drift pattern.
--
-- This migration was applied directly to prod via Dashboard SQL on
-- 2026-05-18 02:50Z without a matching local file. The orphan in
-- supabase_migrations.schema_migrations.version='20260518025033' has
-- blocked every `supabase db push --include-all` since, which means
-- the migration CI job has been red on every merge since PR #109
-- (4 PRs: #109, #113, #115, #117). The recovery is the user-documented
-- playbook: pull the orphan statements from
-- supabase_migrations.schema_migrations and commit them at the applied
-- timestamp so the migrator's local↔remote diff goes empty.
--
-- The body below is verbatim from the prod row's `statements` array
-- (concatenated; each item was a separate statement when the Dashboard
-- SQL was executed). Every CREATE/REVOKE/GRANT is idempotent so this
-- file is safe to re-apply on environments that already have it (it
-- becomes a no-op via `if not exists` and `drop trigger if exists`).
--
-- See also: 20260521120000_jp_ingestion_observability_indexes.sql,
-- which now carries only the two indexes PR #115 added on top of this
-- orphan (run_id_idx, printing_id_idx) instead of redefining the
-- whole table.
--
-- See: memory note "Migration drift recurrence" for prior occurrences
-- and the diagnostic shortcut (`gh run list --workflow supabase-migrations.yml`).

-- JP ingestion observability.
--
-- The Yahoo! JP and Snkrdunk cron routes used to expose health only in
-- the HTTP response body. That made Vercel logs the only durable place
-- to answer "did the cron run, what did it try, and why did it not
-- write?" These tables keep run summaries and per-candidate outcomes in
-- Postgres so operators can diagnose low-sample loops, scrape failures,
-- and timeout halts from the database.

create table if not exists public.jp_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('YAHOO_JP', 'SNKRDUNK')),
  route text not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  mode text null check (mode in ('processed', 'halted', 'no-work', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  batch_size integer null check (batch_size is null or batch_size >= 0),
  candidates_available integer not null default 0 check (candidates_available >= 0),
  processed integer not null default 0 check (processed >= 0),
  written integer not null default 0 check (written >= 0),
  low_sample integer not null default 0 check (low_sample >= 0),
  scrape_failed integer not null default 0 check (scrape_failed >= 0),
  write_failed integer not null default 0 check (write_failed >= 0),
  no_query integer not null default 0 check (no_query >= 0),
  halt_reason text null,
  error text null,
  elapsed_ms integer null check (elapsed_ms is null or elapsed_ms >= 0),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jp_ingestion_runs_provider_started_idx
  on public.jp_ingestion_runs (provider, started_at desc);

create index if not exists jp_ingestion_runs_status_started_idx
  on public.jp_ingestion_runs (status, started_at desc);

comment on table public.jp_ingestion_runs is
  'Durable run summaries for JP-native ingestion crons. Written by '
  '/api/cron/run-yahoo-jp-daily and /api/cron/run-snkrdunk-daily.';

comment on column public.jp_ingestion_runs.mode is
  'Route-level outcome mode: processed, halted, no-work, or failed.';

create table if not exists public.jp_ingestion_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid null references public.jp_ingestion_runs(id) on delete set null,
  provider text not null check (provider in ('YAHOO_JP', 'SNKRDUNK')),
  canonical_slug text not null references public.canonical_cards(slug) on delete cascade,
  source_key text null,
  printing_id uuid null references public.card_printings(id) on delete set null,
  status text not null check (status in ('ok', 'low-sample', 'scrape-failed', 'write-failed', 'no-query')),
  raw_count integer null check (raw_count is null or raw_count >= 0),
  rows_written integer not null default 0 check (rows_written >= 0),
  price_usd numeric null,
  sample_count integer null check (sample_count is null or sample_count >= 0),
  reason text null,
  elapsed_ms integer null check (elapsed_ms is null or elapsed_ms >= 0),
  metadata jsonb not null default '{}'::jsonb,
  attempted_at timestamptz not null default now()
);

create index if not exists jp_ingestion_attempts_provider_attempted_idx
  on public.jp_ingestion_attempts (provider, attempted_at desc);

create index if not exists jp_ingestion_attempts_slug_attempted_idx
  on public.jp_ingestion_attempts (provider, canonical_slug, attempted_at desc);

create index if not exists jp_ingestion_attempts_source_key_attempted_idx
  on public.jp_ingestion_attempts (provider, source_key, attempted_at desc)
  where source_key is not null;

create index if not exists jp_ingestion_attempts_status_attempted_idx
  on public.jp_ingestion_attempts (provider, status, attempted_at desc);

comment on table public.jp_ingestion_attempts is
  'Per-card/product outcomes for JP-native ingestion. Also used as a '
  'cooldown source so low-sample/no-query candidates do not block the '
  'same cron queue every hour.';

comment on column public.jp_ingestion_attempts.source_key is
  'Provider-specific re-fetch key. Null for Yahoo! JP; Snkrdunk writes '
  'the SW--- product code.';

comment on column public.jp_ingestion_attempts.status is
  'Candidate-level outcome. Non-ok statuses are used by cron candidate '
  'selection to temporarily skip recently unproductive cards.';

create or replace function public.jp_ingestion_runs_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_jp_ingestion_runs_set_updated_at on public.jp_ingestion_runs;
create trigger trg_jp_ingestion_runs_set_updated_at
before update on public.jp_ingestion_runs
for each row execute function public.jp_ingestion_runs_set_updated_at();

alter table public.jp_ingestion_runs enable row level security;
alter table public.jp_ingestion_attempts enable row level security;

revoke all on table public.jp_ingestion_runs from public, anon, authenticated;
revoke all on table public.jp_ingestion_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.jp_ingestion_runs to service_role;
grant select, insert, update, delete on table public.jp_ingestion_attempts to service_role;

revoke all on function public.jp_ingestion_runs_set_updated_at() from public, anon, authenticated;
