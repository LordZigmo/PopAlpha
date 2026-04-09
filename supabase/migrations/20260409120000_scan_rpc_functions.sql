-- Bypass PostgREST query builder for scan queries that produce
-- "non-integer constant in ORDER BY" errors. These RPCs execute
-- the same SQL that works when run directly, avoiding PostgREST's
-- query generation entirely.

-- 1. Match candidate scan on provider_normalized_observations
CREATE OR REPLACE FUNCTION public.scan_normalized_observations(
  p_provider text,
  p_provider_set_id text DEFAULT NULL,
  p_min_observed_at timestamptz DEFAULT NULL,
  p_ascending boolean DEFAULT false,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(id uuid)
LANGUAGE sql STABLE
SET statement_timeout = '30s'
AS $$
  SELECT o.id
  FROM public.provider_normalized_observations o
  WHERE o.provider = p_provider
    AND (p_provider_set_id IS NULL OR o.provider_set_id = p_provider_set_id)
    AND (p_min_observed_at IS NULL OR o.observed_at >= p_min_observed_at)
  ORDER BY
    CASE WHEN p_ascending THEN o.observed_at END ASC,
    CASE WHEN p_ascending THEN o.id END ASC,
    CASE WHEN NOT p_ascending THEN o.observed_at END DESC,
    CASE WHEN NOT p_ascending THEN o.id END DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;

-- 2. Timeseries/variant-metrics scan on provider_observation_matches
CREATE OR REPLACE FUNCTION public.scan_matched_observations(
  p_provider text,
  p_provider_set_id text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(provider_normalized_observation_id uuid)
LANGUAGE sql STABLE
SET statement_timeout = '30s'
AS $$
  SELECT m.provider_normalized_observation_id
  FROM public.provider_observation_matches m
  WHERE m.provider = p_provider
    AND m.match_status = 'MATCHED'
    AND (p_provider_set_id IS NULL OR m.provider_set_id = p_provider_set_id)
  ORDER BY m.updated_at DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION public.scan_normalized_observations(text, text, timestamptz, boolean, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scan_matched_observations(text, text, integer, integer) TO authenticated, service_role;
