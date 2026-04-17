-- =============================================================================
-- bulk-prune-rpc-20260417.sql
--
-- Adds a focused server-side RPC to drain price_history_points >90d rows
-- without PostgREST's ~1000-row response cap crippling the Node-side batcher.
--
-- Context: scripts/bulk-prune-old-price-history.mjs was getting ~182 rows/sec
-- because .select("id").limit(20000) was capped at 1000 rows by PostgREST's
-- db_max_rows. At that rate the 4.17M row backlog would take ~6 hours.
-- This RPC moves SELECT+DELETE into one server-side transaction: 1 round-trip
-- per 50k rows instead of ~500, bringing full drain to ~5-10 minutes.
--
-- Also committed as supabase/migrations/20260417...sql for future deploys.
-- Paste this block into Supabase Studio to apply RIGHT NOW.
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

create or replace function public.bulk_prune_price_history_points(
  p_batch_size  int         default 50000,
  p_older_than  timestamptz default now() - interval '90 days'
)
returns int
language plpgsql
security definer
set statement_timeout = '60s'
set search_path = public
as $$
declare
  _deleted int;
begin
  delete from public.price_history_points
  where id in (
    select id from public.price_history_points
    where  ts < p_older_than
    limit  greatest(1, p_batch_size)
  );
  get diagnostics _deleted = row_count;
  return _deleted;
end;
$$;

revoke all on function public.bulk_prune_price_history_points(int, timestamptz)
  from public, anon, authenticated;

-- Quick smoke test — should return a small number (or 0 if already drained).
select public.bulk_prune_price_history_points(100);
