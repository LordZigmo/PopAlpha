-- Pending rollups queue for deferred pipeline batch refresh.
-- The provider pipeline used to run 5 heavy refresh RPCs inline per job
-- (refresh_card_metrics_for_variants, refresh_price_changes_for_cards,
-- refresh_card_market_confidence_for_cards,
-- refresh_canonical_raw_provider_parity_for_cards,
-- refresh_set_summary_pipeline_for_variants), adding 60-120s to every job.
--
-- This table lets pipeline jobs queue touched variants for deduplicated
-- hourly batch processing, dropping per-job runtime dramatically while
-- keeping rollup staleness bounded to ~1 hour.

CREATE TABLE IF NOT EXISTS public.pending_rollups (
  canonical_slug text NOT NULL,
  variant_ref text NOT NULL,
  provider text NOT NULL,
  grade text NOT NULL DEFAULT 'RAW',
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_slug, variant_ref, provider, grade)
);

CREATE INDEX IF NOT EXISTS idx_pending_rollups_queued_at
  ON public.pending_rollups (queued_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_rollups TO service_role;

-- Atomic claim-and-delete function so the batch cron can fetch a batch of
-- pending rollups and remove them in a single statement, avoiding races
-- between concurrent cron invocations.
CREATE OR REPLACE FUNCTION public.claim_pending_rollups(p_limit integer DEFAULT 2000)
RETURNS TABLE(
  canonical_slug text,
  variant_ref text,
  provider text,
  grade text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT pr.canonical_slug, pr.variant_ref, pr.provider, pr.grade
    FROM public.pending_rollups pr
    ORDER BY pr.queued_at ASC
    LIMIT GREATEST(1, p_limit)
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.pending_rollups pr
    USING claimed c
    WHERE pr.canonical_slug = c.canonical_slug
      AND pr.variant_ref = c.variant_ref
      AND pr.provider = c.provider
      AND pr.grade = c.grade
    RETURNING pr.canonical_slug, pr.variant_ref, pr.provider, pr.grade
  )
  SELECT d.canonical_slug, d.variant_ref, d.provider, d.grade FROM deleted d;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_rollups(integer) TO service_role, authenticated;
