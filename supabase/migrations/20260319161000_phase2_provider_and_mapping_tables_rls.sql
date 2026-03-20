-- Phase 2.2:
-- Enable row-level security on provider and mapping tables that should remain
-- internal-only behind dbAdmin()/service-role paths.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'label_normalization_rules',
    'provider_card_map',
    'provider_ingests',
    'provider_normalized_observations',
    'provider_observation_matches',
    'provider_raw_payload_lineages',
    'provider_raw_payloads',
    'provider_set_health',
    'provider_set_map'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise notice 'Skipping Phase 2.2 RLS for missing table public.%', table_name;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
  end loop;
end
$$;
