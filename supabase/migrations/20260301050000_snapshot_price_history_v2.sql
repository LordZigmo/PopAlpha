-- 20260301050000_snapshot_price_history_v2.sql
--
-- Updates snapshot_price_history() to read from card_metrics instead of
-- market_snapshot_rollups. Column renames:
--   median_ask_7d  → median_7d
--   low_ask_30d    → low_30d
--   high_ask_30d   → high_30d
--   active_listings_7d → active_listings_7d  (unchanged)

create or replace function public.snapshot_price_history()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  -- Remove today's existing snapshot so re-runs refresh in place.
  delete from public.price_history
  where date = current_date
    and source = 'COMBINED';

  -- Insert a fresh snapshot from card_metrics.
  insert into public.price_history (
    canonical_slug,
    printing_id,
    grade,
    date,
    median_price,
    low_price,
    high_price,
    sample_size,
    source
  )
  select
    cm.canonical_slug,
    cm.printing_id,
    cm.grade,
    current_date,
    cm.median_7d,
    cm.low_30d,
    cm.high_30d,
    coalesce(cm.active_listings_7d, 0),
    'COMBINED'
  from public.card_metrics cm
  where cm.median_7d is not null;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok',   true,
    'date', current_date,
    'rows', affected
  );
end;
$$;
