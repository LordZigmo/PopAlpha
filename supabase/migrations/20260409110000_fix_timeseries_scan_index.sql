-- Fix timeseries and variant-metrics scan performance.
-- Both stages query provider_observation_matches filtered by
-- (provider, match_status, provider_set_id) ordered by updated_at DESC.
-- The existing index (provider, match_status, updated_at DESC) does not
-- include provider_set_id, forcing Postgres to filter rows post-scan.
-- This partial index covers the exact query pattern and only indexes
-- MATCHED rows since that's the only status these stages query.

CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_observation_matches_provider_status_set_idx
  ON public.provider_observation_matches (provider, match_status, provider_set_id, updated_at DESC)
  WHERE match_status = 'MATCHED';
