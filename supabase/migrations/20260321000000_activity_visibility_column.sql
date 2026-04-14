-- 20260321000000_activity_visibility_column.sql
-- Add activity_visibility column to app_users for controlling who sees your activity events.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS activity_visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (activity_visibility IN ('public', 'followers', 'private'));

-- Grant authenticated users the ability to read/write this column (already covered by
-- existing app_users UPDATE policy: owner-only).
