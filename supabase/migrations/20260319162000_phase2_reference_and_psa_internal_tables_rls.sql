-- Phase 2.3:
-- Enable row-level security on PSA/reference internal tables that should
-- remain available only to admin/cron/service-role paths.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'psa_cert_cache',
    'psa_cert_lookup_logs',
    'psa_certificates',
    'psa_seed_certs',
    'realized_sales_backtest_snapshots'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise notice 'Skipping Phase 2.3 RLS for missing table public.%', table_name;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
  end loop;
end
$$;
