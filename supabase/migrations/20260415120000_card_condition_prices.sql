-- 20260415120000_card_condition_prices.sql
--
-- Condition-based pricing: store the latest Scrydex price per condition
-- (nm, lp, mp, hp, dmg) per card printing. The existing NM-only pipeline
-- is untouched; this is a purely additive table populated by a new
-- extraction module that runs alongside the existing normalize/timeseries flow.

create table if not exists public.card_condition_prices (
  id             uuid        primary key default gen_random_uuid(),
  canonical_slug text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id    uuid        null references public.card_printings(id) on delete set null,
  condition      text        not null check (condition in ('nm', 'lp', 'mp', 'hp', 'dmg')),
  price          numeric     not null,
  low_price      numeric     null,
  high_price     numeric     null,
  currency       text        not null default 'USD',
  provider       text        not null,
  observed_at    timestamptz not null,
  updated_at     timestamptz not null default now()
);

-- One row per (slug, printing, condition). NULLs in printing_id treated as
-- identical for canonical-level rows (matches card_metrics pattern).
create unique index if not exists card_condition_prices_dedup_uidx
  on public.card_condition_prices (canonical_slug, printing_id, condition)
  nulls not distinct;

create index if not exists card_condition_prices_slug_idx
  on public.card_condition_prices (canonical_slug);

create index if not exists card_condition_prices_slug_printing_idx
  on public.card_condition_prices (canonical_slug, printing_id)
  where printing_id is not null;

-- Public read view (follows 20260303220000_public_read_views.sql pattern)
create or replace view public.public_card_condition_prices
  as select * from public.card_condition_prices;
grant select on public.public_card_condition_prices to anon, authenticated;
