-- Bound scan_matched_observations to matches updated within the last 90 days.
--
-- The function previously scanned provider_observation_matches filtered only
-- by (provider, match_status='MATCHED', optional provider_set_id), ordered by
-- updated_at DESC, paginated by OFFSET. With 1.6M+ rows and deep offsets, that
-- is a heavy index-range scan even with the partial composite index from
-- 20260409110000_fix_timeseries_scan_index.sql. Combined with the inner
-- statement_timeout removal in 20260410100000_relax_scan_rpc_timeouts.sql, the
-- RPC has no compensating runtime bound at all.
--
-- Adding a hardcoded 90-day WHERE clause (not a parameter) keeps both callers
-- — provider-observation-timeseries.ts:372 and
-- provider-observation-variant-metrics.ts:304 — on the recent index range
-- without any caller change. The function signature is preserved so PostgREST
-- does not need a schema-cache reload.
--
-- If a future workflow needs an unbounded historical replay, write a separate
-- admin RPC (scan_matched_observations_unbounded). Do not add an opt-out
-- parameter to this hot-path function.
--
-- Pre-flight verification before applying: confirm that no active
-- provider_set_id has its newest MATCHED row older than 90 days. If any
-- surfaces, widen the cutoff before re-applying. The check query is in
-- /Users/popalpha/.claude/plans/my-supabase-cpu-is-bubbly-umbrella.md (PR 2).

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
    AND m.updated_at >= now() - interval '90 days'
    AND (p_provider_set_id IS NULL OR m.provider_set_id = p_provider_set_id)
  ORDER BY m.updated_at DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION public.scan_matched_observations(text, text, integer, integer) TO authenticated, service_role;
