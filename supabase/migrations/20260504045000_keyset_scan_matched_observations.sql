-- supersedes: 20260502040000_bound_scan_matched_observations.sql
--
-- Replace OFFSET pagination in scan_matched_observations with keyset
-- pagination. Both callers
-- (lib/backfill/provider-observation-timeseries.ts:377 and
--  lib/backfill/provider-observation-variant-metrics.ts:303)
-- loop with `from += SCAN_PAGE_SIZE`, so deep pages re-scan the index
-- prefix linearly per call → quadratic total work. With ~2.9M MATCHED
-- rows in the 90d window and 5.13M calls in the May 4 pg_stat_statements
-- snapshot, the function alone consumed 74.5% of all DB exec time
-- (6.35M sec / 19 days, mean 1.24s/call).
--
-- The May 2 90-day bound (20260502040000) capped the universe but did
-- not address the OFFSET cost. Keyset pagination uses the existing
-- partial index
--   provider_observation_matches_provider_status_set_idx
--     (provider, match_status, provider_set_id, updated_at DESC)
--     WHERE match_status = 'MATCHED'
-- to seek directly to the cursor position, making each page O(log N)
-- instead of O(offset + limit).
--
-- Cursor is (updated_at, provider_normalized_observation_id) — the
-- observation_id tiebreaker is required to handle the rare case of
-- multiple rows sharing an updated_at timestamp; without it keyset
-- can lose or duplicate rows on ties.
--
-- DEPLOY-SAFETY: this migration ADDS the keyset overload alongside the
-- existing OFFSET signature instead of dropping it. Postgres allows
-- function overloading by parameter list; PostgREST routes RPC calls by
-- the parameter names in the JSON body, so old callers passing
-- p_offset continue to hit the OFFSET function while new callers
-- passing p_after_updated_at/p_after_id hit the keyset overload.
-- This eliminates the deploy-split window where Vercel's ~3min code
-- rollout would race the ~15-25min migrations workflow and break
-- in-flight pipeline jobs (max_attempts=1 makes those failures
-- permanent). After keyset is verified live in prod, a follow-up
-- migration drops the OFFSET signature.
--
-- If a future workflow ever needs OFFSET/historical-replay semantics,
-- write a separate admin RPC. Do not re-introduce p_offset to this
-- keyset overload.

create or replace function public.scan_matched_observations(
  p_provider text,
  p_provider_set_id text default null,
  p_limit integer default 100,
  p_after_updated_at timestamptz default null,
  p_after_id uuid default null
)
returns table(
  provider_normalized_observation_id uuid,
  updated_at timestamptz
)
language sql
stable
as $$
  select m.provider_normalized_observation_id, m.updated_at
  from public.provider_observation_matches m
  where m.provider = p_provider
    and m.match_status = 'MATCHED'
    and m.updated_at >= now() - interval '90 days'
    and (p_provider_set_id is null or m.provider_set_id = p_provider_set_id)
    and (
      p_after_updated_at is null
      or m.updated_at < p_after_updated_at
      or (m.updated_at = p_after_updated_at
          and m.provider_normalized_observation_id < p_after_id)
    )
  order by m.updated_at desc, m.provider_normalized_observation_id desc
  limit p_limit;
$$;

grant execute on function public.scan_matched_observations(text, text, integer, timestamptz, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
