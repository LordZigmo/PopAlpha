-- 20260420140000_card_printings_source_source_id_unique.sql
--
-- Promote the partial unique index card_printings_source_source_id_unique_idx
-- (WHERE source_id IS NOT NULL) to a proper UNIQUE constraint so PostgREST's
-- ON CONFLICT resolver can match `{ onConflict: "source,source_id" }`.
--
-- Why: runScrydexCanonicalImport has always used
--   .upsert(rows, { onConflict: "source,source_id" })
-- but Postgres won't pick a partial unique index for ON CONFLICT unless the
-- query includes the same WHERE predicate — and PostgREST emits plain column
-- lists. The upsert therefore failed with 42P10 for every printing batch,
-- silently skipping inserts. The bug was masked because the legacy
-- Scrydex-driven canonical import path was gated off by ALLOW_PROVIDER_CANONICAL_IMPORT.
-- The new discover-new-sets cron (which seeds provisional rows) exercises
-- this path and exposed it.
--
-- Safety: all 30,758 existing rows have non-null source_id and no duplicates
-- on (source, source_id), so tightening source_id to NOT NULL and adding a
-- full UNIQUE is a no-op for existing data. The pokemon-tcg-data import
-- script doesn't use PostgREST upsert for card_printings (it does manual
-- select-then-update-or-insert), so its behavior is unaffected.

alter table public.card_printings
  alter column source_id set not null;

drop index if exists public.card_printings_source_source_id_unique_idx;

alter table public.card_printings
  add constraint card_printings_source_source_id_key
  unique (source, source_id);
