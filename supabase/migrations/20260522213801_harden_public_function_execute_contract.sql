-- Harden function and sequence grants that drifted via default PUBLIC
-- EXECUTE / broad sequence grants. The schema contract only tracks
-- anon/authenticated exposure, but we also keep service_role grants
-- explicit for trusted cron and backfill callers.

do $$
declare
  fn_name text;
  target_fn regprocedure;
begin
  -- These functions back cron jobs, ingestion/backfill pipelines, or
  -- trigger/helper internals. They should never be direct public RPCs.
  for fn_name in
    select unnest(array[
      'public.apns_device_tokens_set_updated_at()',
      'public.canonical_cards_set_is_digital_trigger()',
      'public.canonical_set_is_digital(text)',
      'public.card_printings_after_delete_sync_sets()',
      'public.card_printings_after_insert_sync_sets()',
      'public.card_printings_after_update_sync_sets()',
      'public.card_printings_assign_set_id()',
      'public.claim_pending_rollups(integer)',
      'public.compute_jp_card_price_changes()',
      'public.get_attention_slugs_for_art_crop(integer,numeric)',
      'public.resolve_grade_id(text)',
      'public.scan_card_printings_by_set(text[],integer,integer)',
      'public.scan_card_printings_for_priority(text[],integer,integer,integer)',
      'public.scan_matched_observations(text,text,integer,integer)',
      'public.scan_matched_observations(text,text,integer,timestamp with time zone,uuid)',
      'public.scan_normalized_observations(text,text,timestamp with time zone,boolean,integer,integer)',
      'public.scan_variant_price_latest_for_priority(text,text[],integer,integer)',
      'public.set_grade_id_from_grade()',
      'public.variant_token_registry_touch_updated_at()'
    ])
  loop
    target_fn := to_regprocedure(fn_name);
    if target_fn is not null then
      execute format(
        'revoke execute on function %s from public, anon, authenticated',
        target_fn
      );
      execute format(
        'grant execute on function %s to service_role',
        target_fn
      );
    end if;
  end loop;

  -- These are intentionally public read helpers. Revoke PUBLIC so the
  -- callable roles are explicit and match the guardrail contract.
  for fn_name in
    select unnest(array[
      'public.get_canonical_raw_daily_freshness_monitors(integer[])',
      'public.preferred_canonical_raw_printing(text)'
    ])
  loop
    target_fn := to_regprocedure(fn_name);
    if target_fn is not null then
      execute format(
        'revoke execute on function %s from public',
        target_fn
      );
      execute format(
        'grant execute on function %s to anon, authenticated, service_role',
        target_fn
      );
    end if;
  end loop;
end $$;

do $$
declare
  seq_name text;
  target_seq regclass;
begin
  -- User-owned write tables need sequence USAGE for inserts, not SELECT.
  for seq_name in
    select unnest(array[
      'public.activity_comments_id_seq',
      'public.activity_events_id_seq',
      'public.apns_device_tokens_id_seq',
      'public.moderation_reports_id_seq',
      'public.notifications_id_seq',
      'public.wishlist_items_id_seq'
    ])
  loop
    target_seq := to_regclass(seq_name);
    if target_seq is not null then
      execute format(
        'revoke all privileges on sequence %s from anon, authenticated',
        target_seq
      );
      execute format(
        'grant usage on sequence %s to authenticated',
        target_seq
      );
    end if;
  end loop;

  -- Internal caches keep no anon/authenticated sequence access.
  for seq_name in
    select unnest(array[
      'public.ai_brief_cache_id_seq'
    ])
  loop
    target_seq := to_regclass(seq_name);
    if target_seq is not null then
      execute format(
        'revoke all privileges on sequence %s from anon, authenticated',
        target_seq
      );
    end if;
  end loop;
end $$;
