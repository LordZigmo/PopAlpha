-- Restore the public AI brief view to the definer-view access model.
--
-- public.ai_brief_cache has RLS enabled and intentionally has no public
-- table grants. The safe public surface is this latest-row view, which only
-- exposes display fields used by iOS/web.

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
