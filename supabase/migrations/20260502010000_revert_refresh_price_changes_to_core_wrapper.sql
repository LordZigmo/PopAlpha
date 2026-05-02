-- 20260502010000_revert_refresh_price_changes_to_core_wrapper.sql
--
-- Revert of 20260501010000_refresh_price_changes_time_anchored_baseline.
--
-- That migration replaced public.refresh_price_changes() with a body lifted
-- from 20260303115000_refresh_price_changes_no_lock_timeout.sql — but that
-- was an OLD JustTCG-only definition. Since then the function had been
-- redefined as a thin wrapper around public.refresh_price_changes_core(),
-- which:
--   - reads from a canonical hourly bucket series across SCRYDEX +
--     POKEMON_TCG_API + JUSTTCG (latest body in
--     20260317093000_phase1_public_live_market_truth_followup.sql);
--   - already uses time-anchored windows ([-36h, -24h] strict, with a
--     [-96h, -24h] fallback);
--   - only updates change_pct_24h / change_pct_7d on card_metrics — it
--     never touches market_price or market_price_as_of.
--
-- The buggy revert re-introduced
--   `set market_price = c.price_now, market_price_as_of = c.latest_ts`
-- on UPDATE, sourced from the JUSTTCG `latest_ts`. JustTCG polls at a
-- much lower cadence than Scrydex, so on every cron tick this clobbered
-- Scrydex-fresh market_price_as_of values across thousands of canonical
-- RAW rows. The catalog-wide "fresh in last 24h" coverage cratered from
-- the normal ~18k+ down to ~2.6k, locking compute_daily_top_movers
-- behind its `coverage_too_low` gate and stranding the stale homepage
-- mover rail (Rayquaza-Deoxys still featured, etc.).
--
-- Fix: restore the wrapper exactly as it was at 20260309224000. _core is
-- left untouched (the latest body in the phase1 followup is still in
-- effect on production).
--
-- After this migration applies, repopulate the data by running, in the
-- Supabase SQL editor:
--
--   select public.refresh_card_metrics();      -- restore market_price /
--                                              -- market_price_as_of
--                                              -- from Scrydex snapshots
--   select public.refresh_price_changes();     -- recompute change_pct_*
--                                              -- via _core
--   select public.compute_daily_top_movers();  -- re-bake homepage rails
--
-- Then pull-to-refresh on iOS Signal Board.

create or replace function public.refresh_price_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
begin
  return public.refresh_price_changes_core(null);
end;
$$;
