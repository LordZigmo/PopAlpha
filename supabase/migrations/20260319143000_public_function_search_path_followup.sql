alter function public.apply_ebay_deletion_manual_review_update(uuid, text, text, boolean, text, text, text, text, text, boolean)
  set search_path = public, pg_temp;

alter function public.backfill_snapshot_history_points_for_sets(text[], integer)
  set search_path = public, pg_temp;

alter function public.claim_ebay_deletion_notification_receipts(text, integer, integer, integer)
  set search_path = public, pg_temp;

alter function public.claim_pipeline_job(text, integer)
  set search_path = public, pg_temp;

alter function public.complete_pipeline_job(bigint, boolean, jsonb, text, integer)
  set search_path = public, pg_temp;

alter function public.enable_row_security_on_new_public_tables()
  set search_path = public, pg_temp;

alter function public.is_handle_available(text)
  set search_path = public, pg_temp;

alter function public.preferred_signal_history_window(text, text)
  set search_path = public, pg_temp;

alter function public.record_card_page_view(text)
  set search_path = public, pg_temp;

alter function public.refresh_canonical_raw_provider_parity_for_cards(text[], integer)
  set search_path = public, pg_temp;

alter function public.refresh_canonical_raw_provider_parity(integer)
  set search_path = public, pg_temp;

alter function public.refresh_card_market_confidence_core(text[])
  set search_path = public, pg_temp;

alter function public.refresh_card_market_confidence_for_cards(text[])
  set search_path = public, pg_temp;

alter function public.refresh_card_market_confidence()
  set search_path = public, pg_temp;

alter function public.refresh_card_metrics_for_variants(jsonb)
  set search_path = public, pg_temp;

alter function public.refresh_card_metrics()
  set search_path = public, pg_temp;

alter function public.refresh_derived_signals_for_variants(jsonb)
  set search_path = public, pg_temp;

alter function public.refresh_derived_signals()
  set search_path = public, pg_temp;

alter function public.refresh_price_changes_core(text[])
  set search_path = public, pg_temp;

alter function public.refresh_price_changes_for_cards(text[])
  set search_path = public, pg_temp;

alter function public.refresh_price_changes()
  set search_path = public, pg_temp;

alter function public.refresh_realized_sales_backtest()
  set search_path = public, pg_temp;

alter function public.resolve_profile_handle(text)
  set search_path = public, pg_temp;

alter function public.snapshot_price_history()
  set search_path = public, pg_temp;

alter view public.community_user_vote_weeks
  set (security_invoker = true);

alter view public.community_vote_feed_events
  set (security_invoker = true);
