-- 20260415110000_price_history_canonical_prefer_printing.sql
--
-- Fix: pin public_price_history_canonical to the single preferred RAW
-- printing per canonical slug, eliminating the multi-variant interleave
-- that causes zigzag chart lines on iOS.
--
-- Two sources of contamination:
--   1. Multiple card_printings (HOLO vs NON_HOLO) each with variant_refs
--      ending in '::RAW'. Fixed by pinning to preferred_canonical_raw_printing.
--   2. Graded Scrydex entries written with variant_refs like
--      '<printingId>::<providerVariantId>::GRADED::PSA::G10::RAW' — they
--      end in '::RAW' but contain graded prices ($109, $192).
--      Fixed by excluding any variant_ref containing '::GRADED::'.
--
-- Performance: preferred_canonical_raw_printing() is STABLE and the view
-- is always queried with a canonical_slug equality filter, so Postgres
-- evaluates the function once per query.

create or replace view public.public_price_history_canonical as
select
  ph.id,
  ph.canonical_slug,
  ph.variant_ref,
  ph.provider,
  ph.ts,
  ph.price,
  ph.currency,
  ph.source_window,
  ph.created_at
from public.price_history_points ph
where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
  and ph.source_window in ('snapshot', '30d')
  and ph.variant_ref like '%::RAW'
  and ph.variant_ref not like '%::GRADED::%'
  and ph.variant_ref like
    coalesce(public.preferred_canonical_raw_printing(ph.canonical_slug)::text, '!!NONE!!') || '::%';

-- Re-grant (view was replaced, grants must be reapplied)
grant select on public.public_price_history_canonical to anon, authenticated;
