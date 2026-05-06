-- supersedes: 20260506210000_scan_matched_observations_row_value_keyset.sql
--
-- The row-value migration earlier today added the right index and
-- rewrote the cursor predicate, but EXPLAIN ANALYZE on the resulting
-- function still showed Postgres rejecting 2.18M rows in a Filter:
--
--   Filter: (((now() - '20 days'::interval) IS NULL)
--            OR (ROW(updated_at, observation_id) < ROW(...)))
--   Rows Removed by Filter: 2,187,830
--   Execution time: 1,261 ms
--
-- Same predicate as a standalone query (no IS NULL branch wrapper)
-- runs in **0.77 ms** with Heap Fetches: 0:
--
--   Index Cond: (provider = 'SCRYDEX' AND updated_at >= now() - 90d
--                AND ROW(updated_at, observation_id) < ROW(...))
--
-- Root cause: SQL-language function inlining preserves the
-- `IS NULL OR row-value-comparison` shape at plan time. Postgres
-- can't determine at planning time which branch will fire, so it
-- degrades the predicate into a Filter even when the IS NULL branch
-- is provably false at execute time.
--
-- Fix: rewrite the function in plpgsql with explicit branching on
-- `p_after_updated_at IS NULL`. plpgsql plans each branch separately
-- the first time it runs, so the cursor branch's WHERE has an
-- unconditional row-value comparison and the planner pushes it into
-- the index range scan. The IS-NULL (first-page) branch was already
-- fast (0.26 ms) — it just gets a slightly cleaner plan.
--
-- The supporting partial index
--   provider_observation_matches_provider_keyset_idx
--     (provider, updated_at DESC, observation_id DESC)
--     WHERE match_status = 'MATCHED'
-- created in 20260506210000 stays in place; this migration only
-- swaps the function body. Same signature, no overload churn.

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
language plpgsql
stable
as $$
begin
  if p_after_updated_at is null then
    return query
      select m.provider_normalized_observation_id, m.updated_at
      from public.provider_observation_matches m
      where m.provider = p_provider
        and m.match_status = 'MATCHED'
        and m.updated_at >= now() - interval '90 days'
        and (p_provider_set_id is null or m.provider_set_id = p_provider_set_id)
      order by m.updated_at desc, m.provider_normalized_observation_id desc
      limit p_limit;
  else
    return query
      select m.provider_normalized_observation_id, m.updated_at
      from public.provider_observation_matches m
      where m.provider = p_provider
        and m.match_status = 'MATCHED'
        and m.updated_at >= now() - interval '90 days'
        and (p_provider_set_id is null or m.provider_set_id = p_provider_set_id)
        and (m.updated_at, m.provider_normalized_observation_id)
            < (p_after_updated_at, p_after_id)
      order by m.updated_at desc, m.provider_normalized_observation_id desc
      limit p_limit;
  end if;
end;
$$;

grant execute on function public.scan_matched_observations(text, text, integer, timestamptz, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
