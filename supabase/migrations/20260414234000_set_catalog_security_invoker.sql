-- Set security_invoker on canonical_set_catalog.
--
-- Most public_* views intentionally use SECURITY DEFINER behavior (the
-- Postgres default) because they are the controlled access layer: the
-- underlying tables (card_metrics, variant_metrics, etc.) have RLS
-- enabled with all access revoked from anon/authenticated.  The view
-- running as the owner is how anon users can read public market data.
--
-- canonical_set_catalog is different — it reads from card_printings,
-- which is directly granted SELECT to anon.  So it can safely use
-- security_invoker without breaking access.

ALTER VIEW public.canonical_set_catalog SET (security_invoker = true);
