-- 20260417000000_bulk_prune_price_history_points.sql
--
-- Focused server-side DELETE helper for draining the price_history_points
-- >90d backlog that accumulated while prune_old_data's 5,000-row/day chunk
-- couldn't keep up.
--
-- Called from scripts/bulk-prune-old-price-history.mjs. Differs from
-- prune_old_data (which is the nightly maintenance helper across 7 tables)
-- by doing one table with a configurable batch size, returning the deleted
-- row count in a single round-trip — avoids PostgREST's db_max_rows cap
-- that crippled the pure-JS batcher.

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
