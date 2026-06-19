-- Add an optional avatar image to app_users so a user's profile picture is
-- stored by PopAlpha (not just Clerk) and can be returned to the owner now and
-- to other users in a follow-up (activity-feed avatars).
--
-- A compact Supabase Storage public URL (card-images/avatars/<hash>) written by
-- the user-gated POST /api/profile/avatar route. (NOT base64 — that would blow
-- past Vercel's 4.5MB response cap on GET /api/profile and is unusable in
-- activity feeds.) RLS already governs app_users (a user can only update their
-- own row), so a nullable column add needs no new policy.
alter table public.app_users
  add column if not exists profile_image_url text;

comment on column public.app_users.profile_image_url is
  'User-set avatar as a public Storage URL (card-images/avatars/), written by POST /api/profile/avatar. Nullable; UI falls back to a handle monogram when absent.';
