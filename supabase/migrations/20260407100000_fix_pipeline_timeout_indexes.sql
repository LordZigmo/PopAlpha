-- Fix pipeline timeout failures caused by missing composite index.
-- The finalizeStaleStartedMatchRuns query filters on (job, source, status, started_at)
-- but only individual indexes existed, forcing a slow scan that times out.

create index if not exists ingest_runs_job_source_status_started_idx
  on public.ingest_runs (job, source, status, started_at desc);
