-- Fix "non-integer constant in ORDER BY" in refresh_card_metrics_for_variants.
-- The April 7 migration (20260407000000) replaced ps.provider with the string
-- literal 'SCRYDEX' in an ORDER BY clause when removing JustTCG. PostgreSQL
-- rejects ORDER BY 'constant_string'. Replace with ps.provider column reference.
--
-- This was the root cause of the pipeline-wide failure cascade: every pipeline
-- job succeeded through ingest → normalize → match → timeseries → variant_metrics
-- but failed at targeted_rollups when calling this function.

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'refresh_card_metrics_for_variants';
  IF v_src IS NULL THEN
    RAISE NOTICE 'refresh_card_metrics_for_variants not found, skipping';
    RETURN;
  END IF;

  -- Replace the string literal 'SCRYDEX' with ps.provider in ORDER BY
  v_src := replace(v_src, E'      ''SCRYDEX'',\n      ps.provider_ref,', E'      ps.provider,\n      ps.provider_ref,');

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.refresh_card_metrics_for_variants(keys jsonb) '
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER '
    'SET statement_timeout = ''0'' SET lock_timeout = ''0'' SET search_path = public '
    'AS $fn$%s$fn$', v_src
  );
END;
$$;
