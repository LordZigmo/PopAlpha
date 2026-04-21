-- 20260421000000_holdings_price_paid_optional.sql
--
-- Make price_paid_usd optional on holdings rows.
--
-- Rationale: users adding cards they've owned for a long time often
-- don't remember what they paid. Forcing a value (or encouraging $0
-- as a substitute) corrupts cost-basis / P&L calculations with
-- misleading "100% profit" results. NULL honestly represents "unknown
-- cost basis" and downstream math already coerces NULL → 0 in JS
-- which keeps totals stable.

alter table public.holdings
  alter column price_paid_usd drop not null;
