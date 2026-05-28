-- PriceCharting foundation for English price corroboration.
--
-- This intentionally does not feed PriceCharting into public_card_metrics yet.
-- PriceCharting starts as an independent backing source that can verify or
-- reject Scrydex-priced homepage candidates before we promote the signal.

create table if not exists public.pricecharting_products (
  product_id              text        primary key,
  product_name            text        not null,
  console_name            text        null,
  genre                   text        null,
  release_date            date        null,
  tcg_id                  text        null,
  asin                    text        null,
  epid                    text        null,
  upc                     text        null,
  sales_volume            integer     null,
  loose_price_usd         numeric     null,
  grade_7_price_usd       numeric     null,
  grade_8_price_usd       numeric     null,
  grade_9_price_usd       numeric     null,
  grade_9_5_price_usd     numeric     null,
  grade_10_price_usd      numeric     null,
  bgs_10_price_usd        numeric     null,
  cgc_10_price_usd        numeric     null,
  sgc_10_price_usd        numeric     null,
  import_source           text        not null default 'csv',
  observed_at             timestamptz not null,
  raw_payload             jsonb       not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint pricecharting_products_product_id_chk
    check (product_id = btrim(product_id) and product_id <> ''),
  constraint pricecharting_products_product_name_chk
    check (product_name = btrim(product_name) and product_name <> ''),
  constraint pricecharting_products_sales_volume_chk
    check (sales_volume is null or sales_volume >= 0),
  constraint pricecharting_products_source_chk
    check (import_source in ('csv', 'api', 'manual')),
  constraint pricecharting_products_positive_prices_chk
    check (
      (loose_price_usd is null or loose_price_usd > 0)
      and (grade_7_price_usd is null or grade_7_price_usd > 0)
      and (grade_8_price_usd is null or grade_8_price_usd > 0)
      and (grade_9_price_usd is null or grade_9_price_usd > 0)
      and (grade_9_5_price_usd is null or grade_9_5_price_usd > 0)
      and (grade_10_price_usd is null or grade_10_price_usd > 0)
      and (bgs_10_price_usd is null or bgs_10_price_usd > 0)
      and (cgc_10_price_usd is null or cgc_10_price_usd > 0)
      and (sgc_10_price_usd is null or sgc_10_price_usd > 0)
    )
);

create index if not exists pricecharting_products_observed_idx
  on public.pricecharting_products (observed_at desc);

create index if not exists pricecharting_products_console_idx
  on public.pricecharting_products (lower(console_name), observed_at desc)
  where console_name is not null;

create index if not exists pricecharting_products_product_name_idx
  on public.pricecharting_products (lower(product_name));

create index if not exists pricecharting_products_tcg_id_idx
  on public.pricecharting_products (tcg_id)
  where tcg_id is not null;

comment on table public.pricecharting_products is
  'Latest imported PriceCharting product rows. Price fields are USD dollars '
  'converted from PriceCharting cents. These rows corroborate PopAlpha prices '
  'and are not used directly as public market prices.';

comment on column public.pricecharting_products.loose_price_usd is
  'PriceCharting loose-price converted from cents to USD dollars. For cards, '
  'PriceCharting defines loose-price as Ungraded card.';

create table if not exists public.pricecharting_product_matches (
  id                 uuid        primary key default gen_random_uuid(),
  product_id         text        not null references public.pricecharting_products(product_id) on delete cascade,
  canonical_slug     text        null references public.canonical_cards(slug) on delete set null,
  printing_id        uuid        null references public.card_printings(id) on delete set null,
  asset_type         text        not null default 'single' check (asset_type in ('single', 'sealed')),
  match_status       text        not null check (match_status in ('MATCHED', 'NEEDS_REVIEW', 'UNMATCHED', 'REJECTED')),
  match_type         text        null,
  match_confidence   numeric     null check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 100)),
  match_reason       text        null,
  mapping_source     text        not null default 'AUTO' check (mapping_source in ('AUTO', 'MANUAL', 'IMPORT', 'REVIEW')),
  identity           jsonb       not null default '{}'::jsonb,
  reviewed_by        text        null,
  reviewed_at        timestamptz null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pricecharting_product_matches_matched_identity_chk
    check (
      match_status <> 'MATCHED'
      or (canonical_slug is not null and match_confidence is not null and match_confidence >= 90)
    )
);

create unique index if not exists pricecharting_product_matches_identity_uidx
  on public.pricecharting_product_matches (product_id, canonical_slug, printing_id)
  nulls not distinct;

create index if not exists pricecharting_product_matches_canonical_idx
  on public.pricecharting_product_matches (canonical_slug, match_status, updated_at desc)
  where canonical_slug is not null;

create index if not exists pricecharting_product_matches_printing_idx
  on public.pricecharting_product_matches (printing_id, match_status, updated_at desc)
  where printing_id is not null;

comment on table public.pricecharting_product_matches is
  'Auditable PriceCharting-to-PopAlpha identity map. Homepage trust should '
  'only use MATCHED rows, with manual review for variant-sensitive cards.';

create table if not exists public.canonical_pricecharting_price_parity (
  canonical_slug             text        primary key references public.canonical_cards(slug) on delete cascade,
  product_id                 text        null references public.pricecharting_products(product_id) on delete set null,
  printing_id                uuid        null references public.card_printings(id) on delete set null,
  pricecharting_price_usd    numeric     null,
  pricecharting_as_of        timestamptz null,
  scrydex_price_usd          numeric     null,
  scrydex_as_of              timestamptz null,
  relative_delta_pct         numeric     null,
  agreement_status           text        not null default 'UNKNOWN'
    check (agreement_status in ('MATCH', 'PRICE_DIVERGED', 'MISSING_PRICECHARTING', 'MISSING_SCRYDEX', 'STALE', 'UNKNOWN')),
  match_status               text        null,
  match_confidence           numeric     null,
  metadata                   jsonb       not null default '{}'::jsonb,
  updated_at                 timestamptz not null default now(),
  constraint canonical_pricecharting_positive_prices_chk
    check (
      (pricecharting_price_usd is null or pricecharting_price_usd > 0)
      and (scrydex_price_usd is null or scrydex_price_usd > 0)
    )
);

create index if not exists canonical_pricecharting_price_parity_status_idx
  on public.canonical_pricecharting_price_parity (agreement_status, updated_at desc);

comment on table public.canonical_pricecharting_price_parity is
  'Materialized Scrydex-vs-PriceCharting agreement signal for English RAW '
  'homepage guardrails. This supplements canonical_raw_provider_parity and '
  'does not make PriceCharting the displayed market price.';

create or replace function public.pricecharting_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_pricecharting_products_set_updated_at
  on public.pricecharting_products;
create trigger trg_pricecharting_products_set_updated_at
before update on public.pricecharting_products
for each row execute function public.pricecharting_set_updated_at();

drop trigger if exists trg_pricecharting_product_matches_set_updated_at
  on public.pricecharting_product_matches;
create trigger trg_pricecharting_product_matches_set_updated_at
before update on public.pricecharting_product_matches
for each row execute function public.pricecharting_set_updated_at();

create or replace function public.refresh_canonical_pricecharting_price_parity(
  p_window_days integer default 7,
  p_agreement_pct numeric default 35
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
  v_window_days integer := greatest(1, coalesce(p_window_days, 7));
  v_agreement_pct numeric := greatest(1, coalesce(p_agreement_pct, 35));
begin
  with matched_products as (
    select *
    from (
      select
        m.product_id,
        m.canonical_slug,
        m.printing_id,
        m.match_status,
        m.match_confidence,
        m.match_type,
        m.match_reason,
        p.loose_price_usd,
        p.observed_at as pricecharting_as_of,
        p.console_name,
        p.product_name,
        row_number() over (
          partition by m.canonical_slug
          order by
            coalesce(m.match_confidence, 0) desc,
            p.observed_at desc,
            m.updated_at desc,
            m.product_id asc
        ) as rn
      from public.pricecharting_product_matches m
      join public.pricecharting_products p
        on p.product_id = m.product_id
      where m.match_status = 'MATCHED'
        and m.canonical_slug is not null
        and p.loose_price_usd is not null
        and p.loose_price_usd > 0
    ) ranked
    where rn = 1
  ),
  scrydex_prices as (
    select
      pcm.canonical_slug,
      pcm.printing_id,
      pcm.market_price,
      pcm.market_price_as_of,
      pcm.market_confidence_score,
      pcm.market_low_confidence,
      pcm.snapshot_count_30d
    from public.public_card_metrics pcm
    where pcm.grade = 'RAW'
      and pcm.market_price is not null
      and pcm.market_price > 0
  ),
  joined as (
    select
      mp.canonical_slug,
      mp.product_id,
      mp.printing_id,
      mp.loose_price_usd as pricecharting_price_usd,
      mp.pricecharting_as_of,
      sp.market_price as scrydex_price_usd,
      sp.market_price_as_of as scrydex_as_of,
      case
        when mp.loose_price_usd is not null
         and sp.market_price is not null
         and ((mp.loose_price_usd + sp.market_price) / 2) > 0
        then round((abs(mp.loose_price_usd - sp.market_price) / ((mp.loose_price_usd + sp.market_price) / 2) * 100)::numeric, 2)
        else null
      end as relative_delta_pct,
      mp.match_status,
      mp.match_confidence,
      jsonb_strip_nulls(jsonb_build_object(
        'matchType', mp.match_type,
        'matchReason', mp.match_reason,
        'pricechartingProductName', mp.product_name,
        'pricechartingConsoleName', mp.console_name,
        'scrydexConfidenceScore', sp.market_confidence_score,
        'scrydexLowConfidence', sp.market_low_confidence,
        'scrydexSnapshotCount30d', sp.snapshot_count_30d
      )) as metadata
    from matched_products mp
    left join scrydex_prices sp
      on sp.canonical_slug = mp.canonical_slug
     and (
       (mp.printing_id is not null and sp.printing_id = mp.printing_id)
       or (mp.printing_id is null and sp.printing_id is null)
     )
  ),
  classified as (
    select
      j.*,
      case
        when j.pricecharting_price_usd is null then 'MISSING_PRICECHARTING'
        when j.scrydex_price_usd is null then 'MISSING_SCRYDEX'
        when j.pricecharting_as_of < now() - make_interval(days => v_window_days)
          or j.scrydex_as_of < now() - make_interval(days => v_window_days)
          then 'STALE'
        when j.relative_delta_pct is not null
          and (
            j.relative_delta_pct <= v_agreement_pct
            or abs(j.pricecharting_price_usd - j.scrydex_price_usd) <= 1
          )
          then 'MATCH'
        else 'PRICE_DIVERGED'
      end as agreement_status
    from joined j
  )
  insert into public.canonical_pricecharting_price_parity (
    canonical_slug,
    product_id,
    printing_id,
    pricecharting_price_usd,
    pricecharting_as_of,
    scrydex_price_usd,
    scrydex_as_of,
    relative_delta_pct,
    agreement_status,
    match_status,
    match_confidence,
    metadata,
    updated_at
  )
  select
    canonical_slug,
    product_id,
    printing_id,
    pricecharting_price_usd,
    pricecharting_as_of,
    scrydex_price_usd,
    scrydex_as_of,
    relative_delta_pct,
    agreement_status,
    match_status,
    match_confidence,
    metadata,
    now()
  from classified
  on conflict (canonical_slug) do update
    set
      product_id = excluded.product_id,
      printing_id = excluded.printing_id,
      pricecharting_price_usd = excluded.pricecharting_price_usd,
      pricecharting_as_of = excluded.pricecharting_as_of,
      scrydex_price_usd = excluded.scrydex_price_usd,
      scrydex_as_of = excluded.scrydex_as_of,
      relative_delta_pct = excluded.relative_delta_pct,
      agreement_status = excluded.agreement_status,
      match_status = excluded.match_status,
      match_confidence = excluded.match_confidence,
      metadata = excluded.metadata,
      updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

alter table public.pricecharting_products enable row level security;
alter table public.pricecharting_product_matches enable row level security;
alter table public.canonical_pricecharting_price_parity enable row level security;

revoke all on table public.pricecharting_products from public, anon, authenticated;
revoke all on table public.pricecharting_product_matches from public, anon, authenticated;
revoke all on table public.canonical_pricecharting_price_parity from public, anon, authenticated;

grant select, insert, update, delete on table public.pricecharting_products to service_role;
grant select, insert, update, delete on table public.pricecharting_product_matches to service_role;
grant select, insert, update, delete on table public.canonical_pricecharting_price_parity to service_role;

revoke execute on function public.pricecharting_set_updated_at() from public, anon, authenticated;
revoke execute on function public.refresh_canonical_pricecharting_price_parity(integer, numeric) from public, anon, authenticated;
grant execute on function public.refresh_canonical_pricecharting_price_parity(integer, numeric) to service_role;
