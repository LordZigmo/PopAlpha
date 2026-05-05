-- Allow the four mid_* rail kinds in daily_top_movers.kind.
--
-- 20260504230000 (three-tier price segmentation) extended the
-- compute_daily_top_movers RPC to write four new rail kinds —
-- mid_gainer, mid_loser, mid_momentum_24h, mid_momentum_7d — but did
-- NOT update the table's CHECK constraint to allow those values. The
-- constraint was last touched in 20260429010250 (budget tier) and
-- still only allowed the original five kinds.
--
-- Result: every cron tick after 20260504230000 deployed would have
-- failed the moment it tried to insert a mid_* row, with
--   ERROR 23514: new row violates check constraint daily_top_movers_kind_check
-- This migration retroactively unblocks the function. The constraint
-- update was applied directly to prod via supabase db query at
-- 2026-05-05 03:19 UTC to unblock the day's rails immediately; this
-- file makes the change replayable on a fresh DB.
--
-- Pattern matches the previous evolution of this constraint:
--   20260424200207  added momentum_24h / momentum_7d
--   20260429010250  added budget_gainer
--   20260505031900  adds mid_gainer / mid_loser / mid_momentum_24h / mid_momentum_7d (this)

alter table public.daily_top_movers drop constraint if exists daily_top_movers_kind_check;
alter table public.daily_top_movers
  add constraint daily_top_movers_kind_check
  check (kind in (
    'gainer', 'loser', 'momentum_24h', 'momentum_7d', 'budget_gainer',
    'mid_gainer', 'mid_loser', 'mid_momentum_24h', 'mid_momentum_7d'
  ));
