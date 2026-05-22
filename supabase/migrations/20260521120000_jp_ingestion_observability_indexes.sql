-- jp_ingestion_observability — supplemental indexes.
--
-- Originally this file recreated the full jp_ingestion_runs +
-- jp_ingestion_attempts schema (PR #115). It was a duplicate of the
-- orphan migration 20260518025033_jp_ingestion_observability.sql
-- (Dashboard SQL on 2026-05-18) that this branch recovers. Keeping
-- both copies would re-apply RLS / GRANT / REVOKE statements
-- harmlessly, but more importantly would re-declare the
-- `jp_ingestion_runs_set_updated_at()` function — triggering the
-- migration-function-body guard's `-- supersedes:` requirement and
-- adding redefinition churn for no schema gain.
--
-- Reduced this file to the two indexes PR #115 added that aren't in
-- the orphan body (run_id lookup, printing_id lookup). Both are
-- `if not exists` so this is safe to re-apply on environments that
-- already have them.

create index if not exists jp_ingestion_attempts_run_id_idx
  on public.jp_ingestion_attempts (run_id)
  where run_id is not null;

create index if not exists jp_ingestion_attempts_printing_id_idx
  on public.jp_ingestion_attempts (printing_id)
  where printing_id is not null;
