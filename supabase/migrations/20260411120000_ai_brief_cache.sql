-- 20260411120000_ai_brief_cache.sql
--
-- Phase 2 AI Brief — append-only cache of LLM-generated homepage briefs.
--
-- The cron route /api/cron/refresh-ai-brief runs hourly, pulls the current
-- HomepageData, asks Gemini to produce a { summary, takeaway } JSON payload,
-- and inserts a row here. Old rows are pruned by the cron to keep the table
-- small (~24 rows at steady state).
--
-- Reads go through public.public_ai_brief_latest, a view that returns only
-- the newest row. The public view is granted to anon + authenticated so the
-- web homepage and the iOS app can read the same cached brief via dbPublic().
-- The underlying table is owned by service-role and carries no public grants.

CREATE TABLE IF NOT EXISTS public.ai_brief_cache (
  id            bigserial PRIMARY KEY,
  version       text        NOT NULL,
  summary       text        NOT NULL,
  takeaway      text        NOT NULL,
  focus_set     text,
  model_label   text        NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  duration_ms   integer,
  source        text        NOT NULL DEFAULT 'llm', -- 'llm' | 'fallback'
  data_as_of    timestamptz,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_brief_cache_generated_at_desc_idx
  ON public.ai_brief_cache (generated_at DESC);

-- Row-level guardrail: briefs must not be empty.
ALTER TABLE public.ai_brief_cache
  ADD CONSTRAINT ai_brief_cache_summary_nonempty CHECK (length(btrim(summary)) > 0),
  ADD CONSTRAINT ai_brief_cache_takeaway_nonempty CHECK (length(btrim(takeaway)) > 0);

-- Public read view: always the single newest row, plus a derived staleness flag
-- so clients can show "updated X minutes ago" without re-implementing logic.
DROP VIEW IF EXISTS public.public_ai_brief_latest;

CREATE VIEW public.public_ai_brief_latest AS
SELECT
  version,
  summary,
  takeaway,
  focus_set,
  model_label,
  source,
  data_as_of,
  generated_at
FROM public.ai_brief_cache
ORDER BY generated_at DESC
LIMIT 1;

GRANT SELECT ON public.public_ai_brief_latest TO anon, authenticated;
