-- Remove the 30s statement_timeout cap from scan RPC functions.
--
-- These caps were added defensively in 20260409120000_scan_rpc_functions.sql
-- while debugging PostgREST "non-integer constant in ORDER BY" issues. Now
-- that the composite indexes exist (provider_normalized_observations_provider_observed_id_idx
-- and provider_observation_matches_provider_status_set_idx), scans on large
-- sets legitimately take longer than 30s (e.g., sv3pt5 with deep OFFSET
-- pagination). The inner 30s cap triggers cascading drain-loop failures
-- that chew through the outer 480s job timeout, causing PIPELINE_JOB_TIMEOUT
-- errors in 16+ jobs over the last 12 hours.
--
-- The outer job timeout (PIPELINE_JOB_TIMEOUT_MS = 480s) is the authoritative
-- runtime bound. This change removes the inner 30s cap so scans complete
-- naturally instead of failing and retrying.

CREATE OR REPLACE FUNCTION public.scan_normalized_observations(
  p_provider text,
  p_provider_set_id text DEFAULT NULL,
  p_min_observed_at timestamptz DEFAULT NULL,
  p_ascending boolean DEFAULT false,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF p_ascending THEN
    RETURN QUERY
      SELECT o.id
      FROM public.provider_normalized_observations o
      WHERE o.provider = p_provider
        AND (p_provider_set_id IS NULL OR o.provider_set_id = p_provider_set_id)
        AND (p_min_observed_at IS NULL OR o.observed_at >= p_min_observed_at)
      ORDER BY o.observed_at ASC, o.id ASC
      LIMIT p_limit OFFSET p_offset;
  ELSE
    RETURN QUERY
      SELECT o.id
      FROM public.provider_normalized_observations o
      WHERE o.provider = p_provider
        AND (p_provider_set_id IS NULL OR o.provider_set_id = p_provider_set_id)
        AND (p_min_observed_at IS NULL OR o.observed_at >= p_min_observed_at)
      ORDER BY o.observed_at DESC, o.id DESC
      LIMIT p_limit OFFSET p_offset;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.scan_matched_observations(
  p_provider text,
  p_provider_set_id text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(provider_normalized_observation_id uuid)
LANGUAGE sql STABLE
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
