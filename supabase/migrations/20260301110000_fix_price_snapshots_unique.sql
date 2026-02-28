-- 20260301110000_fix_price_snapshots_unique.sql
--
-- Replace the partial unique index on price_snapshots with a full unique
-- index so that PostgREST can resolve ON CONFLICT (provider, provider_ref).
--
-- The partial index (WHERE provider_ref IS NOT NULL) is not matched by a
-- simple ON CONFLICT column list, causing the PostgREST upsert to fail with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- NULLS DISTINCT (the PostgreSQL default) means rows with NULL provider_ref
-- are treated as distinct values and will never conflict with each other,
-- which preserves the original intent.

drop index if exists price_snapshots_provider_ref_uidx;

create unique index price_snapshots_provider_ref_uidx
  on public.price_snapshots (provider, provider_ref);
-- NULLS DISTINCT is the default: NULL != NULL for uniqueness purposes,
-- so rows with provider_ref IS NULL are always inserted (never conflict).
