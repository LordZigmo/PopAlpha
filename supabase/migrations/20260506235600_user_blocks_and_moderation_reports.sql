-- 20260506235600_user_blocks_and_moderation_reports.sql
-- App-Store-required moderation surface: per-user blocks + report queue.
--
-- Apple Guideline 1.2 / 1.4.3 require: user-blocking, report mechanism,
-- moderation pipeline, content filtering. This migration adds the two
-- tables that back those flows. The keyword content filter lives in
-- lib/moderation/keyword-blocklist.ts (server-side, applied at write
-- time before insert).
--
-- Tables:
--   user_blocks         — bilateral: A blocking B hides content both ways
--   moderation_reports  — append-only report queue; reviewed by operators

-- ─── 1. user_blocks ────────────────────────────────────────────────────────

CREATE TABLE public.user_blocks (
  blocker_id  TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_no_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX user_blocks_blocked_idx ON public.user_blocks (blocked_id);

-- ─── 2. moderation_reports ────────────────────────────────────────────────

CREATE TABLE public.moderation_reports (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL
                  CHECK (target_kind IN ('comment', 'event', 'profile', 'profile_post')),
  target_id     TEXT NOT NULL,
  target_owner  TEXT REFERENCES public.app_users(clerk_user_id) ON DELETE SET NULL,
  reason        TEXT NOT NULL
                  CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'other')),
  details       TEXT CHECK (details IS NULL OR char_length(details) <= 500),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   TEXT REFERENCES public.app_users(clerk_user_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX moderation_reports_status_created
  ON public.moderation_reports (status, created_at DESC);

CREATE INDEX moderation_reports_target
  ON public.moderation_reports (target_kind, target_id);

CREATE INDEX moderation_reports_reporter
  ON public.moderation_reports (reporter_id, created_at DESC);

-- ─── 3. RLS ────────────────────────────────────────────────────────────────

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_reports ENABLE ROW LEVEL SECURITY;

-- user_blocks: blocker can manage their own block list.
-- We intentionally do NOT let the blocked party see they've been blocked
-- (no SELECT on rows where blocked_id = self). Filtering is enforced
-- server-side by joining user_blocks in feed/comment/profile fetches.
CREATE POLICY user_blocks_select ON public.user_blocks
  FOR SELECT TO authenticated
  USING (blocker_id = public.requesting_clerk_user_id());

CREATE POLICY user_blocks_insert ON public.user_blocks
  FOR INSERT TO authenticated
  WITH CHECK (blocker_id = public.requesting_clerk_user_id());

CREATE POLICY user_blocks_delete ON public.user_blocks
  FOR DELETE TO authenticated
  USING (blocker_id = public.requesting_clerk_user_id());

-- moderation_reports: users can submit reports and see their own;
-- they cannot see anyone else's reports or update status. Operators
-- review via service-role client (bypasses RLS).
CREATE POLICY moderation_reports_insert ON public.moderation_reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = public.requesting_clerk_user_id());

CREATE POLICY moderation_reports_select_own ON public.moderation_reports
  FOR SELECT TO authenticated
  USING (reporter_id = public.requesting_clerk_user_id());

-- ─── 4. Grants ─────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, DELETE ON public.user_blocks TO authenticated;
GRANT SELECT, INSERT ON public.moderation_reports TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.moderation_reports_id_seq TO authenticated;

-- ─── 5. Comment soft-hide flag ─────────────────────────────────────────────
-- Operators can hide individual comments without hard-deleting them.
-- Applied via service-role; not user-writable.

ALTER TABLE public.activity_comments
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS activity_comments_visible
  ON public.activity_comments (event_id, created_at ASC)
  WHERE hidden_at IS NULL;

-- Tighten the existing select policy: hidden comments only visible to author.
DROP POLICY IF EXISTS activity_comments_select ON public.activity_comments;
CREATE POLICY activity_comments_select ON public.activity_comments
  FOR SELECT TO authenticated
  USING (
    hidden_at IS NULL
    OR author_id = public.requesting_clerk_user_id()
  );
