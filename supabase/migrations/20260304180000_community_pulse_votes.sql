CREATE TABLE IF NOT EXISTS public.community_card_votes (
  id            bigserial PRIMARY KEY,
  voter_id      text NOT NULL,
  canonical_slug text NOT NULL,
  vote_side     text NOT NULL CHECK (vote_side IN ('up', 'down')),
  week_start    date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_card_votes_one_per_card_per_week
    UNIQUE (voter_id, canonical_slug, week_start)
);

CREATE INDEX IF NOT EXISTS community_card_votes_week_slug_idx
  ON public.community_card_votes (week_start, canonical_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS community_card_votes_voter_week_idx
  ON public.community_card_votes (voter_id, week_start, created_at DESC);

CREATE OR REPLACE VIEW public.community_user_vote_weeks AS
SELECT
  voter_id,
  week_start,
  count(*)::integer AS votes_used,
  GREATEST(0, 10 - count(*))::integer AS votes_remaining,
  min(created_at) AS first_vote_at,
  max(created_at) AS last_vote_at
FROM public.community_card_votes
GROUP BY voter_id, week_start;

CREATE OR REPLACE VIEW public.community_vote_feed_events AS
SELECT
  ccv.id,
  ccv.voter_id,
  ccv.canonical_slug,
  ccv.vote_side,
  ccv.week_start,
  ccv.created_at,
  cc.canonical_name,
  cc.set_name
FROM public.community_card_votes ccv
LEFT JOIN public.canonical_cards cc
  ON cc.slug = ccv.canonical_slug;
