-- 20260320100000_wishlist.sql
-- Server-backed wishlist synced across web + iOS.
-- Replaces client-only localStorage watchlist for authenticated users.

CREATE TABLE public.wishlist_items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES public.app_users(clerk_user_id) ON DELETE CASCADE
                   DEFAULT public.requesting_clerk_user_id(),
  canonical_slug TEXT NOT NULL REFERENCES public.canonical_cards(slug) ON DELETE CASCADE,
  note           TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, canonical_slug)
);

CREATE INDEX wishlist_items_owner_created
  ON public.wishlist_items (owner_id, created_at DESC);

CREATE INDEX wishlist_items_slug
  ON public.wishlist_items (canonical_slug);

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.wishlist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY wishlist_items_owner_select ON public.wishlist_items
  FOR SELECT TO authenticated
  USING (owner_id = public.requesting_clerk_user_id());

CREATE POLICY wishlist_items_owner_insert ON public.wishlist_items
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = public.requesting_clerk_user_id());

CREATE POLICY wishlist_items_owner_delete ON public.wishlist_items
  FOR DELETE TO authenticated
  USING (owner_id = public.requesting_clerk_user_id());

-- ─── Grants ─────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, DELETE ON public.wishlist_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.wishlist_items_id_seq TO authenticated;
