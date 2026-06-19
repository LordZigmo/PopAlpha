-- Add an optional avatar image to app_users so a user's profile picture is
-- stored by PopAlpha (not just Clerk) and can be returned to the owner now and
-- to other users in a follow-up (activity-feed avatars).
--
-- Mirrors profile_banner_url: a base64 data URL written by the user-gated
-- POST /api/profile/avatar route. RLS already governs app_users (a user can
-- only update their own row), so a nullable column add needs no new policy.
alter table public.app_users
  add column if not exists profile_image_url text;

comment on column public.app_users.profile_image_url is
  'User-set avatar as a base64 data URL, written by POST /api/profile/avatar. Nullable; UI falls back to a handle monogram when absent.';
