-- 20260507000000_default_activity_visibility_private.sql
-- Flip app_users.activity_visibility column DEFAULT from 'public' to 'private'
-- AND retroactively close the leak on existing rows.
--
-- Context: the iOS Feed surface is hidden behind FeatureFlags.isSocialEnabled
-- in v1 because there's no user-discovery UI yet. With no in-app surface
-- to enumerate other users, every user's activity_visibility = 'public'
-- was an implicit default they never opted into — but a direct
-- /api/activity/profile?handle=... call would still return their events.
--
-- This migration:
--   1. Sets the column DEFAULT to 'private' for new signups.
--   2. Mass-updates all existing 'public' rows to 'private' to close
--      the leak retroactively. Users who explicitly chose 'followers'
--      or 'private' are not touched. Reversible by an opposite UPDATE
--      if/when the discovery surface ships.

ALTER TABLE public.app_users
  ALTER COLUMN activity_visibility SET DEFAULT 'private';

UPDATE public.app_users
   SET activity_visibility = 'private'
 WHERE activity_visibility = 'public';
