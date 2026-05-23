-- Store separate homepage AI briefs for EN and JP market modes.
--
-- Existing rows become EN by default. The public view now exposes the
-- latest row per market so /api/homepage/ai-brief can filter by market
-- without JP overwriting the EN cache or vice versa.

ALTER TABLE public.ai_brief_cache
  ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'EN';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ai_brief_cache_market_check'
      AND conrelid = 'public.ai_brief_cache'::regclass
  ) THEN
    ALTER TABLE public.ai_brief_cache
      ADD CONSTRAINT ai_brief_cache_market_check
      CHECK (market IN ('EN', 'JP'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_brief_cache_market_generated_at_desc_idx
  ON public.ai_brief_cache (market, generated_at DESC);

DROP VIEW IF EXISTS public.public_ai_brief_latest;

CREATE VIEW public.public_ai_brief_latest AS
SELECT DISTINCT ON (market)
  market,
  version,
  summary,
  takeaway,
  whats_happening,
  why_it_matters,
  what_to_watch,
  focus_set,
  model_label,
  source,
  data_as_of,
  generated_at
FROM public.ai_brief_cache
ORDER BY market, generated_at DESC;

GRANT SELECT ON public.public_ai_brief_latest TO anon, authenticated;
