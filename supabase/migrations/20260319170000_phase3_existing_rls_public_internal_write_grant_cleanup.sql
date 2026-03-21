-- Phase 3.1:
-- Reassert SELECT-only anon/authenticated grants on public-read tables that
-- already have RLS enabled and internal write paths.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'canonical_raw_provider_parity',
    'market_snapshots',
    'pricing_transparency_snapshots'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select on table public.%I to anon, authenticated', table_name);
  end loop;
end
$$;
