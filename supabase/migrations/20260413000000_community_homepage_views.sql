-- 20260413000000_community_homepage_views.sql
--
-- Public aggregate views for the homepage community rail.
-- These bypass per-user RLS by aggregating counts only — no PII is exposed.
-- The endpoint /api/homepage/community reads these via dbPublic().

-- 1. Trending cards: most referenced in public activity events (last 7 days).
--    Counts collection.card_added + wishlist.card_added events grouped by slug.
DROP VIEW IF EXISTS public.public_community_trending_7d;

CREATE VIEW public.public_community_trending_7d AS
SELECT
  canonical_slug,
  count(*) AS event_count,
  count(DISTINCT actor_id) AS unique_actors
FROM public.activity_events
WHERE canonical_slug IS NOT NULL
  AND visibility = 'public'
  AND event_type IN ('collection.card_added', 'wishlist.card_added')
  AND created_at >= now() - interval '7 days'
GROUP BY canonical_slug
HAVING count(DISTINCT actor_id) >= 2
ORDER BY event_count DESC
LIMIT 20;

GRANT SELECT ON public.public_community_trending_7d TO anon, authenticated;

-- 2. Most wishlisted cards (last 7 days), aggregated by slug.
DROP VIEW IF EXISTS public.public_community_most_saved_7d;

CREATE VIEW public.public_community_most_saved_7d AS
SELECT
  canonical_slug,
  count(*) AS save_count
FROM public.wishlist_items
WHERE created_at >= now() - interval '7 days'
GROUP BY canonical_slug
HAVING count(*) >= 2
ORDER BY save_count DESC
LIMIT 20;

GRANT SELECT ON public.public_community_most_saved_7d TO anon, authenticated;
