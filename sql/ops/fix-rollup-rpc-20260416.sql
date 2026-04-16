-- =============================================================================
-- fix-rollup-rpc-20260416.sql
--
-- EMERGENCY FIX: refresh_card_metrics_for_variants() has been broken since
-- 2026-04-07. It errors on "non-integer constant in DISTINCT ON" because the
-- 04-07 migration replaced ps.provider with the string literal 'SCRYDEX' in
-- BOTH the DISTINCT ON and ORDER BY clauses. Migration
-- 20260409140000_fix_scrydex_literal_in_order_by.sql patched ORDER BY but
-- missed DISTINCT ON. That's why public_card_metrics.market_price_as_of
-- hasn't been updated by pipeline rollups for a week — only the 12h full
-- refresh_card_metrics() backstop has been touching it.
--
-- This is also committed as supabase/migrations/20260416230000_fix_scrydex_literal_in_distinct_on.sql
-- so future fresh deploys get the fix.
--
-- Usage: paste the whole block into Supabase Studio SQL editor. Idempotent
-- (the string-replace is a no-op if already patched).
-- =============================================================================

DO $$
DECLARE
  v_src text;
  v_patched text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'refresh_card_metrics_for_variants';
  IF v_src IS NULL THEN
    RAISE NOTICE 'refresh_card_metrics_for_variants not found, skipping';
    RETURN;
  END IF;

  -- Replace 'SCRYDEX' literal inside DISTINCT ON with ps.provider column ref.
  -- The pattern matches the exact shape the 04-07 migration produced:
  --   ps.grade,
  --   'SCRYDEX',
  --   ps.provider_ref
  --   (followed by closing ")")
  v_patched := replace(
    v_src,
    E'      ps.grade,\n      ''SCRYDEX'',\n      ps.provider_ref\n',
    E'      ps.grade,\n      ps.provider,\n      ps.provider_ref\n'
  );

  IF v_patched = v_src THEN
    RAISE NOTICE 'refresh_card_metrics_for_variants: no DISTINCT ON literal found to patch (already fixed?)';
    RETURN;
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.refresh_card_metrics_for_variants(keys jsonb) '
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER '
    'SET statement_timeout = ''0'' SET lock_timeout = ''0'' SET search_path = public '
    'AS $fn$%s$fn$', v_patched
  );

  RAISE NOTICE 'refresh_card_metrics_for_variants patched successfully';
END;
$$;


-- ── Verify the patch ────────────────────────────────────────────────────────
-- Should return 1 row of jsonb stats. Replace the slug/variant_ref with any
-- real recent row from variant_metrics if the given one no longer exists.
select public.refresh_card_metrics_for_variants(
  '[{"canonical_slug":"sun-moon-95-dragonair","variant_ref":"38a7d14e-4119-475f-b6ea-56283fb92d6c::RAW","provider":"SCRYDEX","grade":"RAW"}]'::jsonb
);


-- ── Confirm market_price_as_of just moved for that card ─────────────────────
select canonical_slug, market_price, market_price_as_of, updated_at
from public.public_card_metrics
where canonical_slug = 'sun-moon-95-dragonair'
  and grade = 'RAW'
  and printing_id is null
limit 1;
-- Expect: market_price_as_of recent (last 1-2 hours if Scrydex has fresh data),
-- updated_at = just now.
