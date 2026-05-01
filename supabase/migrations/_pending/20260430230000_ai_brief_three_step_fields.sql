-- 20260430040000_ai_brief_three_step_fields.sql
--
-- Three-step insight fields for the homepage AI Brief.
--
-- Existing single `summary` column becomes a tight 1-2 sentence headline;
-- the new columns carry the labeled "What's happening / Why it matters /
-- What to watch" content shown in the expanded iOS card.
--
-- All three are NULLABLE so old cached briefs (homepage-brief-v1) stay
-- valid and the public view continues to return them. The cron will
-- backfill them naturally on its next tick after deploy. The iOS client
-- treats these as optional and falls back gracefully if absent.

ALTER TABLE public.ai_brief_cache
  ADD COLUMN IF NOT EXISTS whats_happening text NULL,
  ADD COLUMN IF NOT EXISTS why_it_matters  text NULL,
  ADD COLUMN IF NOT EXISTS what_to_watch   text NULL;

DROP VIEW IF EXISTS public.public_ai_brief_latest;

CREATE VIEW public.public_ai_brief_latest AS
SELECT
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
ORDER BY generated_at DESC
LIMIT 1;

GRANT SELECT ON public.public_ai_brief_latest TO anon, authenticated;
