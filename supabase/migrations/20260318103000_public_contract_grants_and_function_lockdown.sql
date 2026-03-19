-- Phase 2/3 hardening:
-- 1) Lock down callable helper / RPC functions in public.
-- 2) Reduce current public contracts to the minimum required grants.
-- 3) Revoke anon/authenticated access from internal provider/admin/debug objects.
-- 4) Auto-enable RLS for newly created public tables.

alter function public.requesting_clerk_user_id() set search_path = public;

revoke all on function public.requesting_clerk_user_id() from public, anon, authenticated;
grant execute on function public.requesting_clerk_user_id() to authenticated;

revoke all on function public.is_handle_available(text) from public, anon, authenticated;
grant execute on function public.is_handle_available(text) to anon, authenticated;

revoke all on function public.resolve_profile_handle(text) from public, anon, authenticated;
grant execute on function public.resolve_profile_handle(text) to authenticated;

revoke all on function public.record_card_page_view(text) from public, anon, authenticated;
grant execute on function public.record_card_page_view(text) to anon, authenticated;

revoke all on function public.backfill_snapshot_history_points_for_sets(text[], integer) from public, anon, authenticated;
revoke all on function public.claim_pipeline_job(text, integer) from public, anon, authenticated;
revoke all on function public.complete_pipeline_job(bigint, boolean, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.preferred_signal_history_window(text, text) from public, anon, authenticated;
revoke all on function public.refresh_canonical_raw_provider_parity(integer) from public, anon, authenticated;
revoke all on function public.refresh_canonical_raw_provider_parity_for_cards(text[], integer) from public, anon, authenticated;
revoke all on function public.refresh_card_market_confidence() from public, anon, authenticated;
revoke all on function public.refresh_card_market_confidence_core(text[]) from public, anon, authenticated;
revoke all on function public.refresh_card_market_confidence_for_cards(text[]) from public, anon, authenticated;
revoke all on function public.refresh_card_metrics() from public, anon, authenticated;
revoke all on function public.refresh_card_metrics_for_variants(jsonb) from public, anon, authenticated;
revoke all on function public.refresh_derived_signals() from public, anon, authenticated;
revoke all on function public.refresh_derived_signals_for_variants(jsonb) from public, anon, authenticated;
revoke all on function public.refresh_price_changes() from public, anon, authenticated;
revoke all on function public.refresh_price_changes_core(text[]) from public, anon, authenticated;
revoke all on function public.refresh_price_changes_for_cards(text[]) from public, anon, authenticated;
revoke all on function public.refresh_realized_sales_backtest() from public, anon, authenticated;
revoke all on function public.refresh_variant_price_latest() from public, anon, authenticated;
revoke all on function public.refresh_variant_signals_latest() from public, anon, authenticated;
revoke all on function public.snapshot_price_history() from public, anon, authenticated;

do $$
declare
  object_name text;
begin
  foreach object_name in array array[
    'canonical_cards',
    'canonical_raw_provider_parity',
    'canonical_set_catalog',
    'card_aliases',
    'card_printings',
    'card_profiles',
    'deck_cards',
    'fx_rates',
    'market_snapshots',
    'pricing_transparency_snapshots',
    'printing_aliases',
    'public_card_metrics',
    'public_card_page_view_daily',
    'public_card_page_view_totals',
    'public_community_vote_totals',
    'public_market_latest',
    'public_price_history',
    'public_profile_post_mentions',
    'public_profile_posts',
    'public_profile_social_stats',
    'public_psa_snapshots',
    'public_set_finish_summary',
    'public_set_summaries',
    'public_user_profiles',
    'public_variant_metrics',
    'public_variant_movers',
    'public_variant_movers_priced'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', object_name);
    execute format('grant select on table public.%I to anon, authenticated', object_name);
  end loop;

  foreach object_name in array array[
    'community_user_vote_weeks',
    'community_vote_feed_events'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', object_name);
    execute format('grant select on table public.%I to authenticated', object_name);
  end loop;

  foreach object_name in array array[
    'card_embeddings',
    'card_external_mappings',
    'card_metrics',
    'card_page_views',
    'deck_aliases',
    'decks',
    'ingest_runs',
    'label_normalization_rules',
    'listing_observations',
    'market_events',
    'market_latest',
    'market_observations',
    'market_snapshot_rollups',
    'matching_quality_audits',
    'outlier_excluded_points',
    'pipeline_jobs',
    'price_history',
    'price_history_points',
    'price_snapshots',
    'pricing_alert_events',
    'pro_card_metrics',
    'pro_variant_metrics',
    'provider_card_map',
    'provider_ingests',
    'provider_normalized_observations',
    'provider_observation_matches',
    'provider_raw_payload_lineages',
    'provider_raw_payloads',
    'provider_set_health',
    'provider_set_map',
    'psa_cert_cache',
    'psa_cert_lookup_logs',
    'psa_cert_snapshots',
    'psa_certificates',
    'psa_seed_certs',
    'realized_sales_backtest_snapshots',
    'set_finish_summary_latest',
    'set_summary_snapshots',
    'tracked_assets',
    'tracked_refresh_diagnostics',
    'variant_metrics',
    'variant_price_daily',
    'variant_price_latest',
    'variant_sentiment_latest',
    'variant_signals_latest'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', object_name);
  end loop;
end
$$;

revoke all on table public.waitlist_signups from anon, authenticated;
grant insert, update on table public.waitlist_signups to anon, authenticated;

revoke all on sequence public.waitlist_signups_id_seq from anon, authenticated;
grant usage, select on sequence public.waitlist_signups_id_seq to anon, authenticated;

create or replace function public.enable_row_security_on_new_public_tables()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ddl record;
begin
  for ddl in
    select
      n.nspname as schema_name,
      c.relname as table_name
    from pg_event_trigger_ddl_commands() commands
    join pg_class c
      on c.oid = commands.objid
    join pg_namespace n
      on n.oid = c.relnamespace
    where commands.command_tag in ('CREATE TABLE', 'CREATE TABLE AS')
      and commands.object_type = 'table'
      and not commands.in_extension
      and n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format('alter table %I.%I enable row level security', ddl.schema_name, ddl.table_name);
  end loop;
end;
$$;

revoke all on function public.enable_row_security_on_new_public_tables() from public, anon, authenticated;

drop event trigger if exists popalpha_auto_enable_public_table_rls;

create event trigger popalpha_auto_enable_public_table_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS')
  execute function public.enable_row_security_on_new_public_tables();
