-- Phase 2.1:
-- Enable row-level security on internal operational tables that should never
-- be directly accessible to anon/authenticated callers.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'card_embeddings',
    'card_external_mappings',
    'deck_aliases',
    'decks',
    'ingest_runs',
    'listing_observations',
    'market_events',
    'market_observations',
    'matching_quality_audits',
    'outlier_excluded_points',
    'pipeline_jobs',
    'price_snapshots',
    'pricing_alert_events',
    'tracked_assets',
    'tracked_refresh_diagnostics'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise notice 'Skipping Phase 2.1 RLS for missing table public.%', table_name;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
  end loop;
end
$$;
