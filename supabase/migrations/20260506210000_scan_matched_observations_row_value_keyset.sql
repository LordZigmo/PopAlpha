-- supersedes: 20260504045000_keyset_scan_matched_observations.sql
--
-- Make the keyset cursor in scan_matched_observations actually use the
-- index. The May-4 keyset migration added the parameter shape but the
-- predicate it generated —
--
--   (m.updated_at <  p_after_updated_at)
--   OR (m.updated_at = p_after_updated_at AND m.observation_id < p_after_id)
--
-- — could not be pushed into the index because the OR-form prevents
-- the planner from recognizing it as a range scan. EXPLAIN on a
-- mid-range cursor (2026-05-06):
--
--   Index Cond: (provider = 'SCRYDEX' AND match_status = 'MATCHED' AND updated_at >= now() - 90d)
--   Filter:    ((updated_at < cursor_ts) OR (updated_at = cursor_ts AND obs_id < cursor_id))
--   Rows Removed by Filter: 2,179,893
--   Buffers: shared hit=133,907 read=60,994
--   Execution time: 2,256 ms
--
-- Postgres seeks the (provider, MATCHED, 90d) prefix then sequentially
-- scans 2.18M rows in-memory to find the 100 needed. Every paged call
-- pays this cost. pg_stat_statements 2026-05-06: 73.3% of total DB
-- exec time (485k calls × 720ms p-mean × 7d window).
--
-- Two coordinated changes (with a follow-up — see below):
--
-- 1. Rewrite the cursor predicate to a ROW VALUE comparison:
--      (m.updated_at, m.observation_id) < (p_after_updated_at, p_after_id)
--    Postgres treats row-value comparison as a true keyset and pushes
--    it into a multi-column index range scan when the index columns
--    match the comparison's left-hand side.
--
-- 2. Add a partial index that SUPERSEDES the existing
--    `provider_observation_matches_provider_status_set_idx` for the
--    MATCHED keyset path: same `match_status = 'MATCHED'` partial
--    predicate, but the column list is `(provider, updated_at DESC,
--    observation_id DESC)` so the row-value cursor has matching
--    column directions and can pushdown into a true range scan. The
--    May-4 partial and the broader full `provider_status_idx` stay
--    in place — drop in a separate cleanup migration once the new
--    index is verified hot in pg_stat_user_indexes (this is a real
--    follow-up; running three index updates per MATCHED upsert is
--    acceptable transitionally on a 7M-row table but not forever).
--
-- Post-apply note: EXPLAIN ANALYZE after this migration showed that
-- SQL-language function inlining preserved the `IS NULL OR row-value`
-- shape at plan time and degraded the predicate into a Filter even
-- with the new index in place. The follow-up migration
-- 20260506220000_scan_matched_observations_plpgsql_branch.sql swaps
-- the function language to plpgsql with explicit branching, which
-- planned each branch independently and dropped the deep-cursor cost
-- from 2,256 ms → 6.2 ms. The index from THIS migration is what
-- makes that follow-up's pushdown reach a real seek; this migration
-- on its own moves the plan to Index Only Scan but keeps the Filter
-- at runtime.
--
-- Expected impact (with the 220000 follow-up): 2,256 ms → ~6 ms per
-- paged call. 349k seconds / snapshot window → <3000 sec. Single-RPC
-- CPU consumer drops from 73% of total DB time to ~1%.
--
-- Deploy-safety: this CREATE OR REPLACE on the SAME (text, text,
-- integer, timestamptz, uuid) signature simply rebinds the body. No
-- new overload is created; no caller change required. The OFFSET
-- legacy overload from 20260409120000 stays untouched and is still
-- callable by anything still passing p_offset (none of the current
-- callers do).

-- Concurrent index build to avoid blocking writes on a 7M-row table.
-- supabase db push doesn't run inside an explicit transaction, so
-- CONCURRENTLY is allowed here. The IF NOT EXISTS keeps the migration
-- idempotent if a partial concurrent build was retried.
create index concurrently if not exists
  provider_observation_matches_provider_keyset_idx
  on public.provider_observation_matches
    (provider, updated_at desc, provider_normalized_observation_id desc)
  where match_status = 'MATCHED';

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
      or (m.updated_at, m.provider_normalized_observation_id)
         < (p_after_updated_at, p_after_id)
    )
  order by m.updated_at desc, m.provider_normalized_observation_id desc
  limit p_limit;
$$;

grant execute on function public.scan_matched_observations(text, text, integer, timestamptz, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
