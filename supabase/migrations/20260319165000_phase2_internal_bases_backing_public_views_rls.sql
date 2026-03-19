-- Phase 2.6:
-- Enable row-level security on internal base tables that back public read-model
-- views while keeping the public contract on the views only.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'card_metrics',
    'market_latest',
    'price_history',
    'price_history_points',
    'psa_cert_snapshots',
    'set_finish_summary_latest',
    'set_summary_snapshots',
    'variant_metrics',
    'variant_price_daily',
    'variant_price_latest',
    'variant_sentiment_latest',
    'variant_signals_latest'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
  end loop;
end
$$;
