-- 20260506200000_holdings_share_price_publicly.sql
--
-- Adds an opt-in flag so a holding's purchase price can appear as an
-- anonymous data point on the public card-detail price chart. The
-- contributing user picks the toggle when adding the holding (default
-- off); their dot then renders alongside the dealer/listing market line
-- so they can literally watch their purchase appear on the chart they
-- look at. Mechanic mirrors how StockX or Discogs convert private
-- transactions into a public price record — the contribution loop is
-- the feature, not a side effect.
--
-- Privacy model: rows in `holdings` remain owner-private under RLS.
-- The public chart's read path goes through a service-role server
-- endpoint that filters on `share_price_publicly = true` and projects
-- ONLY the date + price (no user_id, no cert, no notes). The flag is
-- the user's explicit consent that those two fields can be exposed
-- anonymously; everything else stays behind RLS as today.
--
-- Default false: existing holdings stay private. Users opt in either
-- when adding a new holding (consent checkbox in the form) or
-- retroactively from a portfolio settings affordance (separate
-- follow-up). Reversible: drop the column.

alter table public.holdings
  add column if not exists share_price_publicly boolean not null default false;

-- Partial index supports the "give me all shared sales for slug X"
-- read path on the card detail chart. Tiny index — only opted-in rows
-- are stored here.
create index if not exists holdings_share_price_publicly_canonical_slug_idx
  on public.holdings (canonical_slug, acquired_on)
  where share_price_publicly = true;

comment on column public.holdings.share_price_publicly is
  'Opt-in: when true, this holding''s price_paid_usd + acquired_on may '
  'be surfaced anonymously on the public card-detail price chart for '
  'the matching canonical_slug. RLS keeps the row owner-private; the '
  'public chart reads via service role and projects only date + price.';
