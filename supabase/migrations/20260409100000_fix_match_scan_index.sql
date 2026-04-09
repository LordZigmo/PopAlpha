-- Fix match scan timeout: add composite index that fully covers the
-- ORDER BY (observed_at, id) used by the match candidate scan in
-- pokemontcg-normalized-match.ts. Without the id column in the index,
-- Postgres re-sorts rows that share the same observed_at, causing
-- statement timeouts on large tables.
--
-- CONCURRENTLY avoids locking the table during index creation.

CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_normalized_observations_provider_observed_id_idx
  ON public.provider_normalized_observations (provider, observed_at DESC, id DESC);
