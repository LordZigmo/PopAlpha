-- Security hardening: enable RLS on all unprotected tables, revoke
-- over-permissive function grants, lock down SECURITY DEFINER functions.
--
-- Public market data remains accessible: the public_card_metrics,
-- public_variant_metrics, and other public_* views have explicit
-- GRANT SELECT to anon/authenticated and bypass the underlying
-- table's RLS since they're owned by the table owner.

-- ── A. Enable RLS on user-scoped tables with existing Clerk policies ────────
-- These tables have correct owner_clerk_id policies from
-- 20260318100000_phase1_clerk_rls_foundation.sql but RLS was never enabled.

ALTER TABLE public.holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_post_card_mentions ENABLE ROW LEVEL SECURITY;

-- ── B. Enable RLS on internal/operational tables ────────────────────────────
-- These have no policies → anon/authenticated get zero rows, which is correct
-- since all access goes through dbAdmin() (service_role bypasses RLS) or
-- through public_* views.

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_card_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_page_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_brief_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.variant_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_card_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_set_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_raw_provider_parity ENABLE ROW LEVEL SECURITY;

-- ── C. Revoke authenticated from internal pipeline function ─────────────────
-- claim_pending_rollups() is an internal pipeline function that was
-- incorrectly granted to authenticated users.

REVOKE EXECUTE ON FUNCTION public.claim_pending_rollups(integer) FROM authenticated;

-- ── D. Lock down SECURITY DEFINER refresh functions ─────────────────────────
-- These bypass RLS and modify card_metrics/variant_metrics.
-- Only service_role (cron jobs) should call them.

REVOKE ALL ON FUNCTION public.refresh_card_metrics() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_price_changes() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_card_market_confidence() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_card_market_confidence_for_cards(text[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_price_changes_for_cards(text[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_old_data() FROM public, anon, authenticated;
