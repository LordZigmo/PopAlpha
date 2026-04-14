-- 20260320000000_activity_social_layer.sql
-- Activity-driven social layer: events, likes, comments, notifications.
-- Supports a following-based collector feed across web + iOS.

-- ─── 1. Activity Events (append-only event log) ─────────────────────────────

CREATE TABLE public.activity_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id       TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  canonical_slug TEXT REFERENCES public.canonical_cards(slug) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES public.app_users(clerk_user_id) ON DELETE SET NULL,
  metadata       JSONB NOT NULL DEFAULT '{}',
  visibility     TEXT NOT NULL DEFAULT 'public'
                   CHECK (visibility IN ('public', 'followers', 'private')),
  dedupe_key     TEXT UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX activity_events_actor_created
  ON public.activity_events (actor_id, created_at DESC);

CREATE INDEX activity_events_card_created
  ON public.activity_events (canonical_slug, created_at DESC)
  WHERE canonical_slug IS NOT NULL;

CREATE INDEX activity_events_created
  ON public.activity_events (created_at DESC);

CREATE INDEX activity_events_type
  ON public.activity_events (event_type);

-- ─── 2. Activity Likes ──────────────────────────────────────────────────────

CREATE TABLE public.activity_likes (
  event_id   BIGINT NOT NULL REFERENCES public.activity_events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX activity_likes_event
  ON public.activity_likes (event_id);

-- ─── 3. Activity Comments ───────────────────────────────────────────────────

CREATE TABLE public.activity_comments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   BIGINT NOT NULL REFERENCES public.activity_events(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX activity_comments_event_created
  ON public.activity_comments (event_id, created_at ASC);

-- ─── 4. Notifications ──────────────────────────────────────────────────────

CREATE TABLE public.notifications (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('like', 'comment', 'follow')),
  actor_id     TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  event_id     BIGINT REFERENCES public.activity_events(id) ON DELETE CASCADE,
  read         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_recipient_unread
  ON public.notifications (recipient_id, read, created_at DESC);

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Activity Events: visible if public, or actor is self, or actor is someone you follow
CREATE POLICY activity_events_select ON public.activity_events
  FOR SELECT TO authenticated
  USING (
    visibility = 'public'
    OR actor_id = public.requesting_clerk_user_id()
    OR (
      visibility = 'followers'
      AND EXISTS (
        SELECT 1 FROM public.profile_follows pf
        WHERE pf.follower_id = public.requesting_clerk_user_id()
          AND pf.followee_id = activity_events.actor_id
      )
    )
  );

CREATE POLICY activity_events_insert ON public.activity_events
  FOR INSERT TO authenticated
  WITH CHECK (actor_id = public.requesting_clerk_user_id());

-- Activity Likes: readable by all authenticated, writable by self
CREATE POLICY activity_likes_select ON public.activity_likes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY activity_likes_insert ON public.activity_likes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.requesting_clerk_user_id());

CREATE POLICY activity_likes_delete ON public.activity_likes
  FOR DELETE TO authenticated
  USING (user_id = public.requesting_clerk_user_id());

-- Activity Comments: readable by all authenticated, writable/deletable by self
CREATE POLICY activity_comments_select ON public.activity_comments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY activity_comments_insert ON public.activity_comments
  FOR INSERT TO authenticated
  WITH CHECK (author_id = public.requesting_clerk_user_id());

CREATE POLICY activity_comments_delete ON public.activity_comments
  FOR DELETE TO authenticated
  USING (author_id = public.requesting_clerk_user_id());

-- Notifications: only visible/updatable by recipient
CREATE POLICY notifications_select ON public.notifications
  FOR SELECT TO authenticated
  USING (recipient_id = public.requesting_clerk_user_id());

CREATE POLICY notifications_update ON public.notifications
  FOR UPDATE TO authenticated
  USING (recipient_id = public.requesting_clerk_user_id())
  WITH CHECK (recipient_id = public.requesting_clerk_user_id());

CREATE POLICY notifications_insert ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- ─── 6. Grants ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT ON public.activity_events TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.activity_likes TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.activity_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.activity_events_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.activity_comments_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.notifications_id_seq TO authenticated;
