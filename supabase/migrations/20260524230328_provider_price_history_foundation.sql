-- supersedes: 20260416000000_downsample_price_history.sql
--
-- First-class provider price history foundation.
--
-- PopAlpha currently has two different history shapes:
--   * price_history_points: provider trend/snapshot points keyed by
--     variant_ref, used by chart and signal rollups.
--   * jp_card_price_history: JP-only append table used by
--     compute_jp_card_price_changes().
--
-- This migration adds a provider-agnostic append table for latest-price
-- observations. It intentionally does not change existing readers or
-- rollups; the first rollout is a low-risk dual-write foundation. New
-- rows are captured by database triggers on the current latest-price
-- stores so both Next.js cron routes and operational .mjs scripts get
-- the same write path:
--
--   price_snapshots        -> provider_price_history (SCRYDEX today)
--   yahoo_jp_card_prices   -> provider_price_history (YAHOO_JP)
--   snkrdunk_card_prices   -> provider_price_history (SNKRDUNK)
--
-- The prune_old_data() body below is lifted from the latest definer in
-- 20260416000000_downsample_price_history.sql and keeps the later
-- 20260522212500 search_path hardening (`set search_path = public`).

create table if not exists public.provider_price_history (
  id             uuid        not null default gen_random_uuid(),
  canonical_slug text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id    uuid        null references public.card_printings(id) on delete set null,
  grade          text        not null default 'RAW',
  provider       text        not null,
  provider_ref   text        null,
  source_table   text        not null,
  source_row_id  text        not null,
  price_value    numeric     not null,
  currency       text        not null default 'USD',
  price_usd      numeric     null,
  price_jpy      numeric     null,
  low_value      numeric     null,
  high_value     numeric     null,
  sample_count   integer     null,
  observed_at    timestamptz null,
  recorded_at    timestamptz not null default now(),
  metadata       jsonb       not null default '{}'::jsonb,
  constraint provider_price_history_pkey primary key (id),
  constraint provider_price_history_provider_chk
    check (provider = upper(btrim(provider)) and provider <> ''),
  constraint provider_price_history_source_table_chk
    check (source_table = btrim(source_table) and source_table <> ''),
  constraint provider_price_history_source_row_id_chk
    check (source_row_id = btrim(source_row_id) and source_row_id <> ''),
  constraint provider_price_history_currency_chk
    check (currency = upper(btrim(currency)) and currency <> ''),
  constraint provider_price_history_price_value_chk
    check (price_value > 0),
  constraint provider_price_history_price_usd_chk
    check (price_usd is null or price_usd > 0),
  constraint provider_price_history_price_jpy_chk
    check (price_jpy is null or price_jpy > 0),
  constraint provider_price_history_low_high_chk
    check (
      (low_value is null or low_value > 0)
      and (high_value is null or high_value > 0)
      and (low_value is null or high_value is null or low_value <= high_value)
    ),
  constraint provider_price_history_sample_count_chk
    check (sample_count is null or sample_count >= 0)
);

create unique index if not exists provider_price_history_source_event_uidx
  on public.provider_price_history (
    provider,
    source_table,
    source_row_id,
    observed_at,
    price_value,
    currency
  )
  nulls not distinct;

create index if not exists provider_price_history_lookup_idx
  on public.provider_price_history (
    canonical_slug,
    printing_id,
    grade,
    provider,
    observed_at desc
  );

create index if not exists provider_price_history_provider_observed_idx
  on public.provider_price_history (provider, observed_at desc);

create index if not exists provider_price_history_retention_idx
  on public.provider_price_history (recorded_at desc);

comment on table public.provider_price_history is
  'Append-only provider-agnostic latest-price observation history. '
  'Database triggers dual-write successful updates from price_snapshots, '
  'yahoo_jp_card_prices, and snkrdunk_card_prices without changing '
  'existing public views or card_metrics rollups.';

comment on column public.provider_price_history.provider is
  'Canonical provider name, uppercased at write time (SCRYDEX, YAHOO_JP, '
  'SNKRDUNK). This intentionally differs from jp_card_price_history.source, '
  'which keeps legacy lower-case source strings for its JP-only populator.';

comment on column public.provider_price_history.provider_ref is
  'Provider-native stable reference when one exists. SCRYDEX uses the '
  'price_snapshots.provider_ref value; SNKRDUNK uses snkrdunk_product_code; '
  'YAHOO_JP is null because listings are structurally matched rather than '
  'keyed by a provider card id.';

comment on column public.provider_price_history.source_table is
  'Current latest-price table that produced this row. Keeps the foundation '
  'auditable while PopAlpha still has provider-specific latest stores.';

comment on column public.provider_price_history.source_row_id is
  'Primary key of the source row at the time the trigger fired. Together '
  'with provider/source_table/observed_at/price_value/currency this makes '
  'the trigger idempotent for retried upserts while still recording a new '
  'row when the observed price or observed_at changes.';

comment on column public.provider_price_history.price_value is
  'Primary price value for the event in `currency`. USD is preferred when '
  'the source row has USD; otherwise JP-native rows can write JPY.';

comment on column public.provider_price_history.recorded_at is
  'Database write time for the append event. Different from observed_at, '
  'which comes from the provider/pipeline aggregation.';

alter table public.provider_price_history enable row level security;
revoke all on table public.provider_price_history from public, anon, authenticated;

create or replace function public.record_provider_price_history_from_price_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_provider text := upper(btrim(coalesce(new.provider, '')));
  v_currency text := upper(btrim(coalesce(new.currency, 'USD')));
begin
  if v_provider = '' or v_currency = '' or new.price_value is null or new.price_value <= 0 then
    return new;
  end if;

  insert into public.provider_price_history (
    canonical_slug,
    printing_id,
    grade,
    provider,
    provider_ref,
    source_table,
    source_row_id,
    price_value,
    currency,
    price_usd,
    price_jpy,
    low_value,
    high_value,
    sample_count,
    observed_at,
    metadata
  )
  values (
    new.canonical_slug,
    new.printing_id,
    coalesce(nullif(btrim(new.grade), ''), 'RAW'),
    v_provider,
    nullif(btrim(coalesce(new.provider_ref, '')), ''),
    'price_snapshots',
    new.id::text,
    new.price_value,
    v_currency,
    case when v_currency = 'USD' then new.price_value else null end,
    case when v_currency = 'JPY' then new.price_value else null end,
    case
      when new.low_value is not null
       and new.low_value > 0
       and (new.high_value is null or new.high_value <= 0 or new.low_value <= new.high_value)
      then new.low_value
      else null
    end,
    case
      when new.high_value is not null
       and new.high_value > 0
       and (new.low_value is null or new.low_value <= 0 or new.low_value <= new.high_value)
      then new.high_value
      else null
    end,
    case when new.sample_count is not null and new.sample_count >= 0 then new.sample_count else null end,
    new.observed_at,
    jsonb_strip_nulls(jsonb_build_object(
      'price_snapshot_id', new.id,
      'ingest_id', new.ingest_id
    ))
  )
  on conflict do nothing;

  return new;
end;
$$;

revoke execute on function public.record_provider_price_history_from_price_snapshot()
  from public, anon, authenticated;

drop trigger if exists price_snapshots_record_provider_price_history
  on public.price_snapshots;

create trigger price_snapshots_record_provider_price_history
  after insert or update of
    canonical_slug,
    printing_id,
    grade,
    provider,
    provider_ref,
    price_value,
    currency,
    low_value,
    high_value,
    sample_count,
    observed_at,
    ingest_id
  on public.price_snapshots
  for each row
  execute function public.record_provider_price_history_from_price_snapshot();

create or replace function public.record_provider_price_history_from_yahoo_jp_card_price()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_price_value numeric;
  v_currency text;
begin
  if new.price_usd is not null and new.price_usd > 0 then
    v_price_value := new.price_usd;
    v_currency := 'USD';
  elsif new.price_jpy is not null and new.price_jpy > 0 then
    v_price_value := new.price_jpy;
    v_currency := 'JPY';
  else
    return new;
  end if;

  insert into public.provider_price_history (
    canonical_slug,
    printing_id,
    grade,
    provider,
    provider_ref,
    source_table,
    source_row_id,
    price_value,
    currency,
    price_usd,
    price_jpy,
    sample_count,
    observed_at,
    metadata
  )
  values (
    new.canonical_slug,
    new.printing_id,
    coalesce(nullif(btrim(new.grade), ''), 'RAW'),
    'YAHOO_JP',
    null,
    'yahoo_jp_card_prices',
    new.id::text,
    v_price_value,
    v_currency,
    case when new.price_usd is not null and new.price_usd > 0 then new.price_usd else null end,
    case when new.price_jpy is not null and new.price_jpy > 0 then new.price_jpy else null end,
    case when new.sample_count is not null and new.sample_count >= 0 then new.sample_count else null end,
    new.observed_at,
    jsonb_strip_nulls(jsonb_build_object(
      'fx_rate_used', new.fx_rate_used
    ))
  )
  on conflict do nothing;

  return new;
end;
$$;

revoke execute on function public.record_provider_price_history_from_yahoo_jp_card_price()
  from public, anon, authenticated;

drop trigger if exists yahoo_jp_card_prices_record_provider_price_history
  on public.yahoo_jp_card_prices;

create trigger yahoo_jp_card_prices_record_provider_price_history
  after insert or update of
    canonical_slug,
    printing_id,
    grade,
    price_usd,
    price_jpy,
    fx_rate_used,
    sample_count,
    observed_at
  on public.yahoo_jp_card_prices
  for each row
  execute function public.record_provider_price_history_from_yahoo_jp_card_price();

create or replace function public.record_provider_price_history_from_snkrdunk_card_price()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_price_value numeric;
  v_currency text;
begin
  if new.price_usd is not null and new.price_usd > 0 then
    v_price_value := new.price_usd;
    v_currency := 'USD';
  elsif new.price_jpy is not null and new.price_jpy > 0 then
    v_price_value := new.price_jpy;
    v_currency := 'JPY';
  else
    return new;
  end if;

  insert into public.provider_price_history (
    canonical_slug,
    printing_id,
    grade,
    provider,
    provider_ref,
    source_table,
    source_row_id,
    price_value,
    currency,
    price_usd,
    price_jpy,
    sample_count,
    observed_at,
    metadata
  )
  values (
    new.canonical_slug,
    new.printing_id,
    coalesce(nullif(btrim(new.grade), ''), 'RAW'),
    'SNKRDUNK',
    nullif(btrim(coalesce(new.snkrdunk_product_code, '')), ''),
    'snkrdunk_card_prices',
    new.id::text,
    v_price_value,
    v_currency,
    case when new.price_usd is not null and new.price_usd > 0 then new.price_usd else null end,
    case when new.price_jpy is not null and new.price_jpy > 0 then new.price_jpy else null end,
    case when new.sample_count is not null and new.sample_count >= 0 then new.sample_count else null end,
    new.observed_at,
    jsonb_strip_nulls(jsonb_build_object(
      'fx_rate_used', new.fx_rate_used,
      'snkrdunk_product_code', new.snkrdunk_product_code
    ))
  )
  on conflict do nothing;

  return new;
end;
$$;

revoke execute on function public.record_provider_price_history_from_snkrdunk_card_price()
  from public, anon, authenticated;

drop trigger if exists snkrdunk_card_prices_record_provider_price_history
  on public.snkrdunk_card_prices;

create trigger snkrdunk_card_prices_record_provider_price_history
  after insert or update of
    canonical_slug,
    printing_id,
    grade,
    price_usd,
    price_jpy,
    fx_rate_used,
    currency,
    sample_count,
    snkrdunk_product_code,
    observed_at
  on public.snkrdunk_card_prices
  for each row
  execute function public.record_provider_price_history_from_snkrdunk_card_price();

create or replace function public.prune_old_data()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  _chunk_limit  int := 5000;
  _deleted      int;
  _ds_deleted   int;
  _result       jsonb := '{}'::jsonb;
begin
  -- 1. provider_raw_payloads - 14-day retention
  delete from public.provider_raw_payloads
  where  id in (
    select id from public.provider_raw_payloads
    where  fetched_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_raw_payloads', _deleted);

  -- 2. provider_ingests - 30-day retention
  delete from public.provider_ingests
  where  id in (
    select id from public.provider_ingests
    where  created_at < now() - interval '30 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_ingests', _deleted);

  -- 3. provider_normalized_observations - 14-day retention
  delete from public.provider_normalized_observations
  where  id in (
    select id from public.provider_normalized_observations
    where  observed_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_normalized_observations', _deleted);

  -- 4. listing_observations - 14-day retention
  delete from public.listing_observations
  where  id in (
    select id from public.listing_observations
    where  observed_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('listing_observations', _deleted);

  -- 5. card_page_views - 90-day retention
  delete from public.card_page_views
  where  id in (
    select id from public.card_page_views
    where  viewed_at < now() - interval '90 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('card_page_views', _deleted);

  -- 6. price_snapshots - 45-day retention
  delete from public.price_snapshots
  where  id in (
    select id from public.price_snapshots
    where  observed_at < now() - interval '45 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('price_snapshots', _deleted);

  -- 7a. price_history_points - 90-day hard delete
  delete from public.price_history_points
  where  id in (
    select id from public.price_history_points
    where  ts < now() - interval '90 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('price_history_points', _deleted);

  -- 7b. price_history_points - downsample 30-31d window
  --     As data crosses the 30-day threshold, keep only 1 point per
  --     (card, variant, provider, source_window) per day.
  _ds_deleted := coalesce(
    (public.downsample_price_history_points_batch(
      _chunk_limit,
      now() - interval '30 days',
      now() - interval '31 days'
    )->>'deleted')::int,
    0
  );
  _result := _result || jsonb_build_object('price_history_points_downsampled', _ds_deleted);

  -- 8. provider_price_history - 180-day retention
  --    This table is the first-class latest-price append stream. Keep
  --    longer than chart history while bounding write amplification.
  delete from public.provider_price_history
  where id in (
    select id from public.provider_price_history
    where recorded_at < now() - interval '180 days'
    limit _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_price_history', _deleted);

  return _result;
end;
$$;

revoke all on function public.prune_old_data() from public, anon, authenticated;
