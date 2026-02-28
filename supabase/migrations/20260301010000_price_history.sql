-- price_history
--
-- Stores a permanent daily snapshot of median prices per card × grade.
-- Populated by the snapshot-price-history cron (runs daily at 6am, after
-- sync-tcg-prices at 5am so TCGPlayer prices are already in listing_observations).
--
-- Unlike market_snapshot_rollups (a rolling 30-day view), rows here are never
-- deleted. This is the foundation for price charts, portfolio P&L, and trend
-- analysis.

create table if not exists public.price_history (
  id             uuid        primary key default gen_random_uuid(),
  canonical_slug text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id    uuid        null references public.card_printings(id) on delete set null,
  grade          text        not null,
  date           date        not null,
  median_price   numeric     null,
  low_price      numeric     null,
  high_price     numeric     null,
  sample_size    integer     not null default 0,
  source         text        not null default 'COMBINED',
  created_at     timestamptz not null default now()
);

-- Primary chart/portfolio lookup: all prices for a card over time.
create index if not exists price_history_lookup_idx
  on public.price_history (canonical_slug, grade, date desc);

-- Secondary: market-wide queries ("what moved today").
create index if not exists price_history_date_idx
  on public.price_history (date desc);


-- snapshot_price_history()
--
-- Reads market_snapshot_rollups (which aggregates EBAY + TCGPLAYER) and
-- writes one row per card × printing × grade for today. Idempotent: deletes
-- any existing rows for today before inserting, so re-running on the same
-- day refreshes rather than duplicates.

create or replace function public.snapshot_price_history()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  -- Remove today's existing snapshot so re-runs refresh in place.
  delete from public.price_history
  where date = current_date
    and source = 'COMBINED';

  -- Insert a fresh snapshot from the live rollup view.
  insert into public.price_history (
    canonical_slug,
    printing_id,
    grade,
    date,
    median_price,
    low_price,
    high_price,
    sample_size,
    source
  )
  select
    r.canonical_slug,
    r.printing_id,
    r.grade,
    current_date,
    r.median_ask_7d,
    r.low_ask_30d,
    r.high_ask_30d,
    coalesce(r.active_listings_7d, 0)::integer,
    'COMBINED'
  from public.market_snapshot_rollups r
  where r.median_ask_7d is not null;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok',   true,
    'date', current_date,
    'rows', affected
  );
end;
$$;
