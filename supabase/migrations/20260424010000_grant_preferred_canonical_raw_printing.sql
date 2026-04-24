-- 20260424010000_grant_preferred_canonical_raw_printing.sql
--
-- Fix silent "blank chart" failure on iOS: public_price_history_canonical
-- calls preferred_canonical_raw_printing(slug) inside its WHERE filter.
-- Postgres checks function EXECUTE against the calling role (not the
-- view owner), so anon's REST queries were failing with
--   42501 permission denied for function preferred_canonical_raw_printing
-- for every card. iOS swallowed the error in the chart catch handler,
-- producing a 500ms spinner → blank rectangle for every slug.
--
-- The function is STABLE + read-only: it selects from card_printings to
-- pick the canonical UUID per slug. No SECURITY concern in exposing to
-- anon/authenticated — every row it can see is already public via the
-- card_printings view layer.
--
-- Root-cause note: the 20260318104000 allowlist revoke was too broad.
-- It revoked EXECUTE from anon/authenticated on functions that are
-- correctly admin-only (refresh_*, ensure_provider_raw_payload_lineage,
-- *_set_updated_at) AND on preferred_canonical_raw_printing, which is
-- referenced from a public view. Phase 2d rewrote the canonical view
-- to use this function (replacing preferred_canonical_raw_variant_ref
-- which had the same problem but was rarely hit because the older view
-- inlined it in a pattern match). Post-Phase-2d the view became
-- unusable for anon, which is what the user hit.

grant execute on function public.preferred_canonical_raw_printing(text)
  to anon, authenticated;
