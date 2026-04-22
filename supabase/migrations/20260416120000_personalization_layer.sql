-- 20260416120000_personalization_layer.sql
-- V1 personalization layer: actor-keyed behavior events, inferred style
-- profiles, guest->user claims, and a per-explanation cache.
--
-- All writes flow through dbAdmin() from server route handlers (same pattern
-- as card_page_views). Anonymous guests cannot set `requesting_clerk_user_id()`,
-- so RLS is enabled-with-zero-grants for anon/authenticated on the
-- internal tables. Signed-in users may read their own profile row via a
-- clerk-scoped SELECT policy — optional path; the main read still goes
-- through the server route.

-- ── 1. Behavior events (append-only) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.personalization_behavior_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_key      TEXT NOT NULL CHECK (char_length(actor_key) BETWEEN 10 AND 200),
  clerk_user_id  TEXT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE SET NULL,
  event_type     TEXT NOT NULL CHECK (event_type IN (
    'card_view',
    'card_search_click',
    'watchlist_add',
    'collection_add',
    'variant_switch',
    'market_signal_expand',
    'ai_analysis_expand',
    'price_history_expand',
    'compare_open',
    'portfolio_open'
  )),
  canonical_slug TEXT NULL REFERENCES public.canonical_cards(slug) ON DELETE SET NULL,
  printing_id    TEXT NULL,
  variant_ref    TEXT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  occurred_at    TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personalization_behavior_events_actor_time
  ON public.personalization_behavior_events (actor_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS personalization_behavior_events_card_time
  ON public.personalization_behavior_events (canonical_slug, occurred_at DESC)
  WHERE canonical_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS personalization_behavior_events_type
  ON public.personalization_behavior_events (event_type);

CREATE INDEX IF NOT EXISTS personalization_behavior_events_clerk_time
  ON public.personalization_behavior_events (clerk_user_id, occurred_at DESC)
  WHERE clerk_user_id IS NOT NULL;

ALTER TABLE public.personalization_behavior_events ENABLE ROW LEVEL SECURITY;

-- No policies: anon/authenticated get zero rows. All access goes through
-- dbAdmin() in server routes, which bypasses RLS via service_role.

-- ── 2. Profiles (latest snapshot per actor_key) ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.personalization_profiles (
  actor_key            TEXT PRIMARY KEY CHECK (char_length(actor_key) BETWEEN 10 AND 200),
  clerk_user_id        TEXT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE SET NULL,
  dominant_style_label TEXT NULL,
  supporting_traits    TEXT[] NOT NULL DEFAULT '{}',
  summary              TEXT NULL,
  confidence           NUMERIC(4, 3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence             JSONB NOT NULL DEFAULT '[]',
  scores               JSONB NOT NULL DEFAULT '{}',
  version              INTEGER NOT NULL DEFAULT 1,
  event_count          INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personalization_profiles_clerk
  ON public.personalization_profiles (clerk_user_id)
  WHERE clerk_user_id IS NOT NULL;

ALTER TABLE public.personalization_profiles ENABLE ROW LEVEL SECURITY;

-- Authenticated users may SELECT their own profile (by clerk_user_id match).
-- This is an optional read path for future direct-from-client reads; V1 reads
-- still flow through the server route with dbAdmin.
CREATE POLICY personalization_profiles_self_select ON public.personalization_profiles
  FOR SELECT TO authenticated
  USING (clerk_user_id = public.requesting_clerk_user_id());

GRANT SELECT ON public.personalization_profiles TO authenticated;

-- ── 3. Actor claims (guest -> authenticated user) ───────────────────────────

CREATE TABLE IF NOT EXISTS public.personalization_actor_claims (
  guest_key     TEXT PRIMARY KEY CHECK (char_length(guest_key) BETWEEN 10 AND 200),
  clerk_user_id TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE,
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personalization_actor_claims_clerk
  ON public.personalization_actor_claims (clerk_user_id);

ALTER TABLE public.personalization_actor_claims ENABLE ROW LEVEL SECURITY;

-- No policies: all access via dbAdmin.

-- ── 4. Explanation cache ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.personalization_explanation_cache (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_key       TEXT NOT NULL CHECK (char_length(actor_key) BETWEEN 10 AND 200),
  canonical_slug  TEXT NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL,
  metrics_hash    TEXT NOT NULL CHECK (char_length(metrics_hash) BETWEEN 1 AND 64),
  payload         JSONB NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS personalization_explanation_cache_unique
  ON public.personalization_explanation_cache (actor_key, canonical_slug, profile_version, metrics_hash);

CREATE INDEX IF NOT EXISTS personalization_explanation_cache_actor_time
  ON public.personalization_explanation_cache (actor_key, generated_at DESC);

ALTER TABLE public.personalization_explanation_cache ENABLE ROW LEVEL SECURITY;

-- No policies: all access via dbAdmin.

-- ── 5. Sequence grants stay closed ──────────────────────────────────────────

-- (Sequences backing BIGINT GENERATED ALWAYS AS IDENTITY columns. No grants
-- to anon/authenticated — writes only via service_role through dbAdmin.)
REVOKE ALL ON SEQUENCE public.personalization_behavior_events_id_seq FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.personalization_explanation_cache_id_seq FROM anon, authenticated;
