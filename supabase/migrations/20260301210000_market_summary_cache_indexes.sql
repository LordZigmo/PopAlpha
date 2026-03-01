-- 20260301210000_market_summary_cache_indexes.sql
--
-- Printing-backed price history now uses canonical variant_ref strings that are
-- globally unique per instrument. This partial unique index makes repeated
-- JustTCG sync runs idempotent on the 30d history cache without colliding with
-- legacy sealed / provider-shaped refs.

create unique index if not exists price_history_points_provider_variant_ts_window_uidx
  on public.price_history_points (provider, variant_ref, ts, source_window)
  where variant_ref like '%::%';
