-- 20260304212000_refresh_card_metrics_no_timeout.sql
--
-- Keep refresh_card_metrics durable for large datasets by disabling per-call
-- statement and lock timeouts at function level.

alter function public.refresh_card_metrics()
  set statement_timeout = '0';

alter function public.refresh_card_metrics()
  set lock_timeout = '0';
