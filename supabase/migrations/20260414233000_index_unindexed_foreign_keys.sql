-- Add indexes on foreign key columns that Supabase flagged as unindexed.
-- Without these, FK constraint checks and queries by these columns
-- require full table scans.

CREATE INDEX IF NOT EXISTS idx_activity_events_target_user_id
  ON public.activity_events (target_user_id);

CREATE INDEX IF NOT EXISTS idx_activity_likes_user_id
  ON public.activity_likes (user_id);

CREATE INDEX IF NOT EXISTS idx_activity_comments_author_id
  ON public.activity_comments (author_id);

CREATE INDEX IF NOT EXISTS idx_notifications_actor_id
  ON public.notifications (actor_id);

CREATE INDEX IF NOT EXISTS idx_notifications_event_id
  ON public.notifications (event_id);
