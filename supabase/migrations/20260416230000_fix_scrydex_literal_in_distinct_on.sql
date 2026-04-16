-- Fix "non-integer constant in DISTINCT ON" in refresh_card_metrics_for_variants.
--
-- Companion to 20260409140000_fix_scrydex_literal_in_order_by.sql, which patched
-- the ORDER BY but missed the matching DISTINCT ON. The April 7 migration
-- (20260407000000_remove_justtcg_from_scoped_refresh.sql) replaced ps.provider
-- with the string literal 'SCRYDEX' in BOTH clauses. PostgreSQL rejects
-- DISTINCT ON ('constant_string') the same way it rejects ORDER BY.
--
-- This has been silently breaking every pipeline job's targeted_rollups stage
-- since 04-07 — the drain calls the RPC, Postgres errors before executing,
-- and provider-pipeline-rollups.ts stores the error in cardMetricsError and
-- moves on without firing the full-sweep fallback (because the error message
-- is not "function does not exist"). Consequence: market_price_as_of only
-- advances when refresh_card_metrics cron fires as a 12h backstop.
--
-- After this patch, the RPC's first call will re-populate the function body
-- with ps.provider in BOTH clauses.

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'refresh_card_metrics_for_variants';
  IF v_src IS NULL THEN
    RAISE NOTICE 'refresh_card_metrics_for_variants not found, skipping';
    RETURN;
  END IF;

  -- Replace the string literal 'SCRYDEX' with ps.provider in DISTINCT ON.
  -- The 04-07 migration's DISTINCT ON has this exact shape (5 keys, then ")"):
  --   ps.canonical_slug,
  --   ps.printing_id,
  --   ps.grade,
  --   'SCRYDEX',
  --   ps.provider_ref
  v_src := replace(
    v_src,
    E'      ps.grade,\n      ''SCRYDEX'',\n      ps.provider_ref\n',
    E'      ps.grade,\n      ps.provider,\n      ps.provider_ref\n'
  );

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.refresh_card_metrics_for_variants(keys jsonb) '
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER '
    'SET statement_timeout = ''0'' SET lock_timeout = ''0'' SET search_path = public '
    'AS $fn$%s$fn$', v_src
  );
END;
$$;
