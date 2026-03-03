-- Public read views for SSR market data.
-- SECURITY INVOKER = false (PostgreSQL default) means these views execute
-- with the view owner's permissions, bypassing RLS on underlying tables.
-- When RLS is enabled on raw tables, anon/authenticated can still read
-- through these views.

-- card_metrics
CREATE OR REPLACE VIEW public.public_card_metrics AS SELECT * FROM public.card_metrics;
GRANT SELECT ON public.public_card_metrics TO anon, authenticated;

-- variant_metrics
CREATE OR REPLACE VIEW public.public_variant_metrics AS SELECT * FROM public.variant_metrics;
GRANT SELECT ON public.public_variant_metrics TO anon, authenticated;

-- price_history_points
CREATE OR REPLACE VIEW public.public_price_history AS SELECT * FROM public.price_history_points;
GRANT SELECT ON public.public_price_history TO anon, authenticated;

-- market_latest
CREATE OR REPLACE VIEW public.public_market_latest AS SELECT * FROM public.market_latest;
GRANT SELECT ON public.public_market_latest TO anon, authenticated;

-- set_summary_snapshots
CREATE OR REPLACE VIEW public.public_set_summaries AS SELECT * FROM public.set_summary_snapshots;
GRANT SELECT ON public.public_set_summaries TO anon, authenticated;

-- set_finish_summary_latest
CREATE OR REPLACE VIEW public.public_set_finish_summary AS SELECT * FROM public.set_finish_summary_latest;
GRANT SELECT ON public.public_set_finish_summary TO anon, authenticated;

-- psa_cert_snapshots
CREATE OR REPLACE VIEW public.public_psa_snapshots AS SELECT * FROM public.psa_cert_snapshots;
GRANT SELECT ON public.public_psa_snapshots TO anon, authenticated;
