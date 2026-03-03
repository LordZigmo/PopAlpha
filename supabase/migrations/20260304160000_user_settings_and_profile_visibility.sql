-- 20260304160000_user_settings_and_profile_visibility.sql
-- Adds persisted user settings and makes public profiles respect visibility.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS notify_price_alerts BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_weekly_digest BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_product_updates BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_visibility TEXT NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE public.app_users
  DROP CONSTRAINT IF EXISTS app_users_profile_visibility_check;

ALTER TABLE public.app_users
  ADD CONSTRAINT app_users_profile_visibility_check
  CHECK (profile_visibility IN ('PUBLIC', 'PRIVATE'));

DROP VIEW IF EXISTS public.public_user_profiles;
CREATE VIEW public.public_user_profiles AS
SELECT
  handle,
  handle_norm,
  created_at,
  profile_bio,
  profile_banner_url
FROM public.app_users
WHERE handle IS NOT NULL
  AND profile_visibility = 'PUBLIC';

GRANT SELECT ON public.public_user_profiles TO anon, authenticated;
