-- 20260302110000_set_summary_pipeline.sql
--
-- Set summary pipeline:
--   - variant_price_latest: current price cache per variant cohort
--   - variant_price_daily:  daily close rollup per variant cohort
--   - variant_signals_latest: current signal cache per variant cohort
--   - variant_sentiment_latest: optional sentiment hook for future votes
--   - set_finish_summary_latest: current finish breakdown cache per set
--   - set_summary_snapshots: daily set-level snapshot history
--
-- The snapshot logic uses the current "best" primary variant per card:
--   1) Prefer NON_HOLO when available
--   2) Otherwise prefer the most liquid row (most 30d observations)
--   3) Then the most recently observed row
--
-- This keeps set-level market cap stable even when finish mapping is imperfect.

create or replace function public.normalize_set_id(raw_set_name text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(both '-' from regexp_replace(lower(coalesce(raw_set_name, '')), '[^a-z0-9]+', '-', 'g')),
    ''
  );
$$;

create table if not exists public.variant_price_latest (
  provider               text        not null,
  variant_ref            text        not null,
  grade                  text        not null default 'RAW',
  canonical_slug         text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id            uuid        null references public.card_printings(id) on delete set null,
  set_id                 text        null,
  set_name               text        null,
  finish                 text        null,
  latest_price           numeric     not null,
  latest_currency        text        not null default 'USD',
  latest_observed_at     timestamptz not null,
  latest_source_window   text        not null default '30d',
  observation_count_30d  integer     not null default 0,
  first_observed_at_30d  timestamptz null,
  last_observed_at_30d   timestamptz null,
  updated_at             timestamptz not null default now(),
  primary key (provider, variant_ref, grade)
);

create index if not exists variant_price_latest_set_id_idx
  on public.variant_price_latest (set_id, latest_observed_at desc);

create index if not exists variant_price_latest_printing_idx
  on public.variant_price_latest (printing_id);

create index if not exists variant_price_latest_slug_idx
  on public.variant_price_latest (canonical_slug);

create index if not exists variant_price_latest_set_finish_idx
  on public.variant_price_latest (set_id, finish);

create table if not exists public.variant_price_daily (
  provider          text        not null,
  variant_ref       text        not null,
  grade             text        not null default 'RAW',
  canonical_slug    text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id       uuid        null references public.card_printings(id) on delete set null,
  set_id            text        null,
  set_name          text        null,
  finish            text        null,
  as_of_date        date        not null,
  close_price       numeric     not null,
  average_price     numeric     not null,
  low_price         numeric     not null,
  high_price        numeric     not null,
  sample_count      integer     not null default 0,
  observed_at_max   timestamptz not null,
  updated_at        timestamptz not null default now(),
  primary key (provider, variant_ref, grade, as_of_date)
);

create index if not exists variant_price_daily_set_date_idx
  on public.variant_price_daily (set_id, as_of_date desc);

create index if not exists variant_price_daily_variant_date_idx
  on public.variant_price_daily (provider, variant_ref, as_of_date desc);

create index if not exists variant_price_daily_slug_date_idx
  on public.variant_price_daily (canonical_slug, as_of_date desc);

create table if not exists public.variant_signals_latest (
  provider             text        not null,
  variant_ref          text        not null,
  grade                text        not null default 'RAW',
  canonical_slug       text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id          uuid        null references public.card_printings(id) on delete set null,
  set_id               text        null,
  set_name             text        null,
  finish               text        null,
  signal_trend         numeric     null,
  signal_breakout      numeric     null,
  signal_value         numeric     null,
  history_points_30d   integer     not null default 0,
  provider_as_of_ts    timestamptz null,
  signals_as_of_ts     timestamptz null,
  updated_at           timestamptz not null default now(),
  primary key (provider, variant_ref, grade)
);

create index if not exists variant_signals_latest_set_id_idx
  on public.variant_signals_latest (set_id);

create index if not exists variant_signals_latest_breakout_idx
  on public.variant_signals_latest (set_id, signal_breakout desc);

create table if not exists public.variant_sentiment_latest (
  provider             text        not null default 'COMMUNITY',
  variant_ref          text        not null,
  grade                text        not null default 'RAW',
  canonical_slug       text        null references public.canonical_cards(slug) on delete cascade,
  printing_id          uuid        null references public.card_printings(id) on delete set null,
  set_id               text        null,
  set_name             text        null,
  finish               text        null,
  question_key         text        null,
  question_open        boolean     not null default true,
  sentiment_up_pct     numeric     null,
  vote_count           integer     not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (provider, variant_ref, grade)
);

create index if not exists variant_sentiment_latest_set_id_idx
  on public.variant_sentiment_latest (set_id, updated_at desc);

create table if not exists public.set_finish_summary_latest (
  set_id                text        not null,
  set_name              text        not null,
  finish                text        not null,
  market_cap            numeric     not null default 0,
  card_count            integer     not null default 0,
  change_7d_pct         numeric     null,
  change_30d_pct        numeric     null,
  updated_at            timestamptz not null default now(),
  primary key (set_id, finish)
);

create index if not exists set_finish_summary_latest_set_idx
  on public.set_finish_summary_latest (set_id);

create table if not exists public.set_summary_snapshots (
  set_id                text        not null,
  set_name              text        not null,
  as_of_date            date        not null,
  market_cap            numeric     not null default 0,
  market_cap_all_variants numeric   not null default 0,
  change_7d_pct         numeric     null,
  change_30d_pct        numeric     null,
  heat_score            numeric     not null default 0,
  breakout_count        integer     not null default 0,
  value_zone_count      integer     not null default 0,
  trend_bullish_count   integer     not null default 0,
  sentiment_up_pct      numeric     null,
  vote_count            integer     not null default 0,
  top_movers_json       jsonb       not null default '[]'::jsonb,
  top_losers_json       jsonb       not null default '[]'::jsonb,
  updated_at            timestamptz not null default now(),
  primary key (set_id, as_of_date)
);

create index if not exists set_summary_snapshots_latest_idx
  on public.set_summary_snapshots (set_id, as_of_date desc);

create index if not exists set_summary_snapshots_rank_idx
  on public.set_summary_snapshots (as_of_date desc, heat_score desc);

create or replace function public.refresh_variant_price_latest()
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  truncate table public.variant_price_latest;

  insert into public.variant_price_latest (
    provider,
    variant_ref,
    grade,
    canonical_slug,
    printing_id,
    set_id,
    set_name,
    finish,
    latest_price,
    latest_currency,
    latest_observed_at,
    latest_source_window,
    observation_count_30d,
    first_observed_at_30d,
    last_observed_at_30d,
    updated_at
  )
  with ranked as (
    select
      php.provider,
      php.variant_ref,
      'RAW'::text as grade,
      php.canonical_slug,
      case
        when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f-]{36}$'
          then split_part(php.variant_ref, '::', 1)::uuid
        else null
      end as derived_printing_id,
      php.price,
      php.currency,
      php.ts,
      php.source_window,
      row_number() over (
        partition by php.provider, php.variant_ref
        order by php.ts desc, php.price desc
      ) as rn,
      count(*) filter (where php.ts >= now() - interval '30 days') over (
        partition by php.provider, php.variant_ref
      ) as observation_count_30d,
      min(php.ts) filter (where php.ts >= now() - interval '30 days') over (
        partition by php.provider, php.variant_ref
      ) as first_observed_at_30d,
      max(php.ts) filter (where php.ts >= now() - interval '30 days') over (
        partition by php.provider, php.variant_ref
      ) as last_observed_at_30d
    from public.price_history_points php
  )
  select
    r.provider,
    r.variant_ref,
    r.grade,
    r.canonical_slug,
    cp.id as printing_id,
    public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) as set_id,
    coalesce(cp.set_name, cc.set_name) as set_name,
    cp.finish,
    r.price as latest_price,
    r.currency as latest_currency,
    r.ts as latest_observed_at,
    r.source_window as latest_source_window,
    r.observation_count_30d,
    r.first_observed_at_30d,
    r.last_observed_at_30d,
    now()
  from ranked r
  join public.canonical_cards cc
    on cc.slug = r.canonical_slug
  left join public.card_printings cp
    on cp.id = r.derived_printing_id
  where r.rn = 1;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_variant_price_latest_for_variants(keys jsonb)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  if coalesce(jsonb_array_length(coalesce(keys, '[]'::jsonb)), 0) = 0 then
    return 0;
  end if;

  delete from public.variant_price_latest vpl
  using (
    select distinct
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  ) k
  where vpl.provider = k.provider
    and vpl.variant_ref = k.variant_ref
    and vpl.grade = k.grade;

  insert into public.variant_price_latest (
    provider,
    variant_ref,
    grade,
    canonical_slug,
    printing_id,
    set_id,
    set_name,
    finish,
    latest_price,
    latest_currency,
    latest_observed_at,
    latest_source_window,
    observation_count_30d,
    first_observed_at_30d,
    last_observed_at_30d,
    updated_at
  )
  with requested_keys as (
    select distinct
      item->>'canonical_slug' as canonical_slug,
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'canonical_slug', '') <> ''
      and coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  ),
  ranked as (
    select
      rk.provider,
      rk.variant_ref,
      rk.grade,
      php.canonical_slug,
      case
        when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f-]{36}$'
          then split_part(php.variant_ref, '::', 1)::uuid
        else null
      end as derived_printing_id,
      php.price,
      php.currency,
      php.ts,
      php.source_window,
      row_number() over (
        partition by rk.provider, rk.variant_ref, rk.grade
        order by php.ts desc, php.price desc
      ) as rn,
      count(*) filter (where php.ts >= now() - interval '30 days') over (
        partition by rk.provider, rk.variant_ref, rk.grade
      ) as observation_count_30d,
      min(php.ts) filter (where php.ts >= now() - interval '30 days') over (
        partition by rk.provider, rk.variant_ref, rk.grade
      ) as first_observed_at_30d,
      max(php.ts) filter (where php.ts >= now() - interval '30 days') over (
        partition by rk.provider, rk.variant_ref, rk.grade
      ) as last_observed_at_30d
    from requested_keys rk
    join public.price_history_points php
      on php.provider = rk.provider
     and php.variant_ref = rk.variant_ref
     and php.canonical_slug = rk.canonical_slug
  )
  select
    r.provider,
    r.variant_ref,
    r.grade,
    r.canonical_slug,
    cp.id as printing_id,
    public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) as set_id,
    coalesce(cp.set_name, cc.set_name) as set_name,
    cp.finish,
    r.price as latest_price,
    r.currency as latest_currency,
    r.ts as latest_observed_at,
    r.source_window as latest_source_window,
    r.observation_count_30d,
    r.first_observed_at_30d,
    r.last_observed_at_30d,
    now()
  from ranked r
  join public.canonical_cards cc
    on cc.slug = r.canonical_slug
  left join public.card_printings cp
    on cp.id = r.derived_printing_id
  where r.rn = 1
  on conflict (provider, variant_ref, grade)
  do update set
    canonical_slug = excluded.canonical_slug,
    printing_id = excluded.printing_id,
    set_id = excluded.set_id,
    set_name = excluded.set_name,
    finish = excluded.finish,
    latest_price = excluded.latest_price,
    latest_currency = excluded.latest_currency,
    latest_observed_at = excluded.latest_observed_at,
    latest_source_window = excluded.latest_source_window,
    observation_count_30d = excluded.observation_count_30d,
    first_observed_at_30d = excluded.first_observed_at_30d,
    last_observed_at_30d = excluded.last_observed_at_30d,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_variant_price_daily(lookback_days integer default 35)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  delete from public.variant_price_daily
  where as_of_date >= current_date - greatest(lookback_days, 1);

  insert into public.variant_price_daily (
    provider,
    variant_ref,
    grade,
    canonical_slug,
    printing_id,
    set_id,
    set_name,
    finish,
    as_of_date,
    close_price,
    average_price,
    low_price,
    high_price,
    sample_count,
    observed_at_max,
    updated_at
  )
  with base as (
    select
      php.provider,
      php.variant_ref,
      'RAW'::text as grade,
      php.canonical_slug,
      case
        when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f-]{36}$'
          then split_part(php.variant_ref, '::', 1)::uuid
        else null
      end as derived_printing_id,
      (php.ts at time zone 'utc')::date as as_of_date,
      php.ts,
      php.price
    from public.price_history_points php
    where php.ts >= ((current_date - greatest(lookback_days, 1))::timestamp at time zone 'utc')
  ),
  ranked as (
    select
      b.*,
      row_number() over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
        order by b.ts desc, b.price desc
      ) as rn,
      avg(b.price) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as average_price,
      min(b.price) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as low_price,
      max(b.price) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as high_price,
      count(*) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as sample_count,
      max(b.ts) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as observed_at_max
    from base b
  )
  select
    r.provider,
    r.variant_ref,
    r.grade,
    r.canonical_slug,
    cp.id as printing_id,
    public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) as set_id,
    coalesce(cp.set_name, cc.set_name) as set_name,
    cp.finish,
    r.as_of_date,
    r.price as close_price,
    r.average_price,
    r.low_price,
    r.high_price,
    r.sample_count,
    r.observed_at_max,
    now()
  from ranked r
  join public.canonical_cards cc
    on cc.slug = r.canonical_slug
  left join public.card_printings cp
    on cp.id = r.derived_printing_id
  where r.rn = 1;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_variant_price_daily_for_variants(keys jsonb, lookback_days integer default 35)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  if coalesce(jsonb_array_length(coalesce(keys, '[]'::jsonb)), 0) = 0 then
    return 0;
  end if;

  delete from public.variant_price_daily vpd
  using (
    select distinct
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  ) k
  where vpd.provider = k.provider
    and vpd.variant_ref = k.variant_ref
    and vpd.grade = k.grade
    and vpd.as_of_date >= current_date - greatest(lookback_days, 1);

  insert into public.variant_price_daily (
    provider,
    variant_ref,
    grade,
    canonical_slug,
    printing_id,
    set_id,
    set_name,
    finish,
    as_of_date,
    close_price,
    average_price,
    low_price,
    high_price,
    sample_count,
    observed_at_max,
    updated_at
  )
  with requested_keys as (
    select distinct
      item->>'canonical_slug' as canonical_slug,
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'canonical_slug', '') <> ''
      and coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  ),
  base as (
    select
      rk.provider,
      rk.variant_ref,
      rk.grade,
      php.canonical_slug,
      case
        when split_part(php.variant_ref, '::', 1) ~* '^[0-9a-f-]{36}$'
          then split_part(php.variant_ref, '::', 1)::uuid
        else null
      end as derived_printing_id,
      (php.ts at time zone 'utc')::date as as_of_date,
      php.ts,
      php.price
    from requested_keys rk
    join public.price_history_points php
      on php.provider = rk.provider
     and php.variant_ref = rk.variant_ref
     and php.canonical_slug = rk.canonical_slug
    where php.ts >= ((current_date - greatest(lookback_days, 1))::timestamp at time zone 'utc')
  ),
  ranked as (
    select
      b.*,
      row_number() over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
        order by b.ts desc, b.price desc
      ) as rn,
      avg(b.price) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as average_price,
      min(b.price) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as low_price,
      max(b.price) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as high_price,
      count(*) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as sample_count,
      max(b.ts) over (
        partition by b.provider, b.variant_ref, b.grade, b.as_of_date
      ) as observed_at_max
    from base b
  )
  select
    r.provider,
    r.variant_ref,
    r.grade,
    r.canonical_slug,
    cp.id as printing_id,
    public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) as set_id,
    coalesce(cp.set_name, cc.set_name) as set_name,
    cp.finish,
    r.as_of_date,
    r.price as close_price,
    r.average_price,
    r.low_price,
    r.high_price,
    r.sample_count,
    r.observed_at_max,
    now()
  from ranked r
  join public.canonical_cards cc
    on cc.slug = r.canonical_slug
  left join public.card_printings cp
    on cp.id = r.derived_printing_id
  where r.rn = 1
  on conflict (provider, variant_ref, grade, as_of_date)
  do update set
    canonical_slug = excluded.canonical_slug,
    printing_id = excluded.printing_id,
    set_id = excluded.set_id,
    set_name = excluded.set_name,
    finish = excluded.finish,
    close_price = excluded.close_price,
    average_price = excluded.average_price,
    low_price = excluded.low_price,
    high_price = excluded.high_price,
    sample_count = excluded.sample_count,
    observed_at_max = excluded.observed_at_max,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_variant_signals_latest()
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  truncate table public.variant_signals_latest;

  insert into public.variant_signals_latest (
    provider,
    variant_ref,
    grade,
    canonical_slug,
    printing_id,
    set_id,
    set_name,
    finish,
    signal_trend,
    signal_breakout,
    signal_value,
    history_points_30d,
    provider_as_of_ts,
    signals_as_of_ts,
    updated_at
  )
  select
    vm.provider,
    vm.variant_ref,
    vm.grade,
    vm.canonical_slug,
    vm.printing_id,
    public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) as set_id,
    coalesce(cp.set_name, cc.set_name) as set_name,
    cp.finish,
    vm.signal_trend,
    vm.signal_breakout,
    vm.signal_value,
    coalesce(vm.history_points_30d, 0),
    vm.provider_as_of_ts,
    vm.signals_as_of_ts,
    now()
  from public.variant_metrics vm
  join public.canonical_cards cc
    on cc.slug = vm.canonical_slug
  left join public.card_printings cp
    on cp.id = vm.printing_id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_variant_signals_latest_for_variants(keys jsonb)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  if coalesce(jsonb_array_length(coalesce(keys, '[]'::jsonb)), 0) = 0 then
    return 0;
  end if;

  delete from public.variant_signals_latest vsl
  using (
    select distinct
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  ) k
  where vsl.provider = k.provider
    and vsl.variant_ref = k.variant_ref
    and vsl.grade = k.grade;

  insert into public.variant_signals_latest (
    provider,
    variant_ref,
    grade,
    canonical_slug,
    printing_id,
    set_id,
    set_name,
    finish,
    signal_trend,
    signal_breakout,
    signal_value,
    history_points_30d,
    provider_as_of_ts,
    signals_as_of_ts,
    updated_at
  )
  with requested_keys as (
    select distinct
      item->>'canonical_slug' as canonical_slug,
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'canonical_slug', '') <> ''
      and coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  )
  select
    vm.provider,
    vm.variant_ref,
    vm.grade,
    vm.canonical_slug,
    vm.printing_id,
    public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) as set_id,
    coalesce(cp.set_name, cc.set_name) as set_name,
    cp.finish,
    vm.signal_trend,
    vm.signal_breakout,
    vm.signal_value,
    coalesce(vm.history_points_30d, 0),
    vm.provider_as_of_ts,
    vm.signals_as_of_ts,
    now()
  from requested_keys rk
  join public.variant_metrics vm
    on vm.canonical_slug = rk.canonical_slug
   and vm.provider = rk.provider
   and vm.variant_ref = rk.variant_ref
   and vm.grade = rk.grade
  join public.canonical_cards cc
    on cc.slug = vm.canonical_slug
  left join public.card_printings cp
    on cp.id = vm.printing_id
  on conflict (provider, variant_ref, grade)
  do update set
    canonical_slug = excluded.canonical_slug,
    printing_id = excluded.printing_id,
    set_id = excluded.set_id,
    set_name = excluded.set_name,
    finish = excluded.finish,
    signal_trend = excluded.signal_trend,
    signal_breakout = excluded.signal_breakout,
    signal_value = excluded.signal_value,
    history_points_30d = excluded.history_points_30d,
    provider_as_of_ts = excluded.provider_as_of_ts,
    signals_as_of_ts = excluded.signals_as_of_ts,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_set_finish_summary_latest(only_set_ids text[] default null)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  if only_set_ids is null then
    truncate table public.set_finish_summary_latest;
  else
    delete from public.set_finish_summary_latest
    where set_id = any(only_set_ids);
  end if;

  insert into public.set_finish_summary_latest (
    set_id,
    set_name,
    finish,
    market_cap,
    card_count,
    change_7d_pct,
    change_30d_pct,
    updated_at
  )
  with filtered as (
    select *
    from public.variant_price_latest
    where set_id is not null
      and set_name is not null
      and (only_set_ids is null or set_id = any(only_set_ids))
  ),
  by_finish as (
    select
      vpl.set_id,
      vpl.set_name,
      coalesce(vpl.finish, 'UNKNOWN') as finish,
      count(distinct vpl.canonical_slug) as card_count,
      sum(vpl.latest_price) as market_cap,
      sum(vpd7.close_price) as market_cap_7d,
      sum(vpd30.close_price) as market_cap_30d
    from filtered vpl
    left join public.variant_price_daily vpd7
      on vpd7.provider = vpl.provider
     and vpd7.variant_ref = vpl.variant_ref
     and vpd7.grade = vpl.grade
     and vpd7.as_of_date = current_date - 7
    left join public.variant_price_daily vpd30
      on vpd30.provider = vpl.provider
     and vpd30.variant_ref = vpl.variant_ref
     and vpd30.grade = vpl.grade
     and vpd30.as_of_date = current_date - 30
    group by vpl.set_id, vpl.set_name, coalesce(vpl.finish, 'UNKNOWN')
  )
  select
    bf.set_id,
    bf.set_name,
    bf.finish,
    coalesce(round(bf.market_cap, 2), 0),
    bf.card_count,
    case
      when bf.market_cap_7d is null or bf.market_cap_7d = 0 then null
      else round(((bf.market_cap - bf.market_cap_7d) / bf.market_cap_7d) * 100, 2)
    end,
    case
      when bf.market_cap_30d is null or bf.market_cap_30d = 0 then null
      else round(((bf.market_cap - bf.market_cap_30d) / bf.market_cap_30d) * 100, 2)
    end,
    now()
  from by_finish bf
  on conflict (set_id, finish)
  do update set
    set_name = excluded.set_name,
    market_cap = excluded.market_cap,
    card_count = excluded.card_count,
    change_7d_pct = excluded.change_7d_pct,
    change_30d_pct = excluded.change_30d_pct,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_set_summary_snapshots(
  target_as_of_date date default current_date,
  only_set_ids text[] default null
)
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  delete from public.set_summary_snapshots
  where as_of_date = target_as_of_date
    and (only_set_ids is null or set_id = any(only_set_ids));

  insert into public.set_summary_snapshots (
    set_id,
    set_name,
    as_of_date,
    market_cap,
    market_cap_all_variants,
    change_7d_pct,
    change_30d_pct,
    heat_score,
    breakout_count,
    value_zone_count,
    trend_bullish_count,
    sentiment_up_pct,
    vote_count,
    top_movers_json,
    top_losers_json,
    updated_at
  )
  with effective_prices as (
    select
      base.provider,
      base.variant_ref,
      base.grade,
      base.canonical_slug,
      base.printing_id,
      base.set_id,
      base.set_name,
      base.finish,
      base.as_of_price,
      base.as_of_observed_at,
      coalesce(
        (
          select sum(vpd_hist.sample_count)
          from public.variant_price_daily vpd_hist
          where vpd_hist.provider = base.provider
            and vpd_hist.variant_ref = base.variant_ref
            and vpd_hist.grade = base.grade
            and vpd_hist.as_of_date between target_as_of_date - 29 and target_as_of_date
        ),
        vpl.observation_count_30d,
        0
      ) as observation_count_30d
    from (
      select
        vpd0.provider,
        vpd0.variant_ref,
        vpd0.grade,
        vpd0.canonical_slug,
        vpd0.printing_id,
        vpd0.set_id,
        vpd0.set_name,
        vpd0.finish,
        vpd0.close_price as as_of_price,
        vpd0.observed_at_max as as_of_observed_at
      from public.variant_price_daily vpd0
      where vpd0.as_of_date = target_as_of_date
        and vpd0.set_id is not null
        and vpd0.set_name is not null
        and (only_set_ids is null or vpd0.set_id = any(only_set_ids))

      union all

      select
        vpl.provider,
        vpl.variant_ref,
        vpl.grade,
        vpl.canonical_slug,
        vpl.printing_id,
        vpl.set_id,
        vpl.set_name,
        vpl.finish,
        vpl.latest_price as as_of_price,
        vpl.latest_observed_at as as_of_observed_at
      from public.variant_price_latest vpl
      where target_as_of_date = current_date
        and vpl.set_id is not null
        and vpl.set_name is not null
        and (only_set_ids is null or vpl.set_id = any(only_set_ids))
        and not exists (
          select 1
          from public.variant_price_daily vpd0
          where vpd0.provider = vpl.provider
            and vpd0.variant_ref = vpl.variant_ref
            and vpd0.grade = vpl.grade
            and vpd0.as_of_date = target_as_of_date
        )
    ) base
    left join public.variant_price_latest vpl
      on vpl.provider = base.provider
     and vpl.variant_ref = base.variant_ref
     and vpl.grade = base.grade
  ),
  ranked_primary as (
    select
      l.*,
      row_number() over (
        partition by l.canonical_slug
        order by
          case when l.finish = 'NON_HOLO' then 0 else 1 end,
          l.observation_count_30d desc,
          l.as_of_observed_at desc,
          l.as_of_price desc,
          l.variant_ref asc
      ) as primary_rank
    from effective_prices l
  ),
  primary_variants as (
    select *
    from ranked_primary
    where primary_rank = 1
  ),
  primary_enriched as (
    select
      pv.set_id,
      pv.set_name,
      pv.canonical_slug,
      pv.variant_ref,
      pv.provider,
      pv.grade,
      pv.finish,
      pv.as_of_price,
      pv.observation_count_30d,
      vpd7.close_price as price_7d,
      vpd30.close_price as price_30d,
      case
        when vpd7.close_price is null or vpd7.close_price = 0 then null
        else round(((pv.as_of_price - vpd7.close_price) / vpd7.close_price) * 100, 2)
      end as change_7d_pct_card,
      case
        when vpd30.close_price is null or vpd30.close_price = 0 then null
        else round(((pv.as_of_price - vpd30.close_price) / vpd30.close_price) * 100, 2)
      end as change_30d_pct_card,
      vsl.signal_trend,
      vsl.signal_breakout,
      vsl.signal_value,
      coalesce(vsl.history_points_30d, 0) as signal_history_points_30d,
      vst.sentiment_up_pct,
      coalesce(vst.vote_count, 0) as vote_count
    from primary_variants pv
    left join public.variant_price_daily vpd7
      on vpd7.provider = pv.provider
     and vpd7.variant_ref = pv.variant_ref
     and vpd7.grade = pv.grade
     and vpd7.as_of_date = target_as_of_date - 7
    left join public.variant_price_daily vpd30
      on vpd30.provider = pv.provider
     and vpd30.variant_ref = pv.variant_ref
     and vpd30.grade = pv.grade
     and vpd30.as_of_date = target_as_of_date - 30
    left join public.variant_signals_latest vsl
      on vsl.provider = pv.provider
     and vsl.variant_ref = pv.variant_ref
     and vsl.grade = pv.grade
     and coalesce(
       (vsl.signals_as_of_ts at time zone 'utc')::date,
       (vsl.provider_as_of_ts at time zone 'utc')::date
     ) <= target_as_of_date
    left join public.variant_sentiment_latest vst
      on vst.variant_ref = pv.variant_ref
     and vst.grade = pv.grade
     and vst.question_open = true
     and (vst.updated_at at time zone 'utc')::date <= target_as_of_date
  ),
  set_rollup as (
    select
      pe.set_id,
      min(pe.set_name) as set_name,
      sum(pe.as_of_price) as market_cap,
      sum(pe.price_7d) as market_cap_7d,
      sum(pe.price_30d) as market_cap_30d,
      avg(abs(coalesce(pe.change_7d_pct_card, 0))) as avg_abs_change_7d,
      avg(least(coalesce(pe.observation_count_30d, 0), 30)) as avg_activity_30d,
      count(*) filter (
        where coalesce(pe.signal_breakout, 0) >= 70 and pe.signal_history_points_30d >= 10
      ) as breakout_count,
      count(*) filter (
        where coalesce(pe.signal_value, 0) >= 70 and pe.signal_history_points_30d >= 10
      ) as value_zone_count,
      count(*) filter (
        where coalesce(pe.signal_trend, 0) >= 60 and pe.signal_history_points_30d >= 10
      ) as trend_bullish_count,
      sum(pe.vote_count) as vote_count,
      case
        when sum(pe.vote_count) = 0 then null
        else round(sum(coalesce(pe.sentiment_up_pct, 0) * pe.vote_count) / sum(pe.vote_count), 2)
      end as sentiment_up_pct,
      count(*) as primary_card_count
    from primary_enriched pe
    group by pe.set_id
  ),
  all_variants_rollup as (
    select
      l.set_id,
      sum(l.as_of_price) as market_cap_all_variants
    from effective_prices l
    group by l.set_id
  ),
  movers as (
    select
      pe.set_id,
      jsonb_agg(
        jsonb_build_object(
          'canonical_slug', pe.canonical_slug,
          'variant_ref', pe.variant_ref,
          'price', round(pe.as_of_price, 2),
          'change_7d_pct', pe.change_7d_pct_card,
          'finish', pe.finish
        )
        order by pe.change_7d_pct_card desc nulls last, pe.as_of_price desc
      ) filter (where pe.change_7d_pct_card is not null) as movers_json,
      jsonb_agg(
        jsonb_build_object(
          'canonical_slug', pe.canonical_slug,
          'variant_ref', pe.variant_ref,
          'price', round(pe.as_of_price, 2),
          'change_7d_pct', pe.change_7d_pct_card,
          'finish', pe.finish
        )
        order by pe.change_7d_pct_card asc nulls last, pe.as_of_price desc
      ) filter (where pe.change_7d_pct_card is not null) as losers_json
    from primary_enriched pe
    group by pe.set_id
  )
  select
    sr.set_id,
    sr.set_name,
    target_as_of_date,
    round(sr.market_cap, 2),
    round(coalesce(avr.market_cap_all_variants, 0), 2),
    case
      when sr.market_cap_7d is null or sr.market_cap_7d = 0 then null
      else round(((sr.market_cap - sr.market_cap_7d) / sr.market_cap_7d) * 100, 2)
    end as change_7d_pct,
    case
      when sr.market_cap_30d is null or sr.market_cap_30d = 0 then null
      else round(((sr.market_cap - sr.market_cap_30d) / sr.market_cap_30d) * 100, 2)
    end as change_30d_pct,
    round(
      (
        coalesce(sr.avg_abs_change_7d, 0) * 0.60
        + (coalesce(sr.avg_activity_30d, 0) / 30.0) * 25.0
        + (case when sr.primary_card_count = 0 then 0 else (sr.breakout_count::numeric / sr.primary_card_count) end) * 15.0
      ),
      2
    ) as heat_score,
    sr.breakout_count,
    sr.value_zone_count,
    sr.trend_bullish_count,
    sr.sentiment_up_pct,
    coalesce(sr.vote_count, 0),
    coalesce(
      case
        when jsonb_array_length(coalesce(m.movers_json, '[]'::jsonb)) > 5
          then (
            select jsonb_agg(value)
            from (
              select value
              from jsonb_array_elements(m.movers_json)
              limit 5
            ) top5
          )
        else m.movers_json
      end,
      '[]'::jsonb
    ) as top_movers_json,
    coalesce(
      case
        when jsonb_array_length(coalesce(m.losers_json, '[]'::jsonb)) > 5
          then (
            select jsonb_agg(value)
            from (
              select value
              from jsonb_array_elements(m.losers_json)
              limit 5
            ) top5
          )
        else m.losers_json
      end,
      '[]'::jsonb
    ) as top_losers_json,
    now()
  from set_rollup sr
  left join all_variants_rollup avr
    on avr.set_id = sr.set_id
  left join movers m
    on m.set_id = sr.set_id
  on conflict (set_id, as_of_date)
  do update set
    set_name = excluded.set_name,
    market_cap = excluded.market_cap,
    market_cap_all_variants = excluded.market_cap_all_variants,
    change_7d_pct = excluded.change_7d_pct,
    change_30d_pct = excluded.change_30d_pct,
    heat_score = excluded.heat_score,
    breakout_count = excluded.breakout_count,
    value_zone_count = excluded.value_zone_count,
    trend_bullish_count = excluded.trend_bullish_count,
    sentiment_up_pct = excluded.sentiment_up_pct,
    vote_count = excluded.vote_count,
    top_movers_json = excluded.top_movers_json,
    top_losers_json = excluded.top_losers_json,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.refresh_set_summary_pipeline(
  target_as_of_date date default current_date,
  lookback_days integer default 35
)
returns jsonb
language plpgsql
as $$
declare
  latest_rows integer := 0;
  daily_rows integer := 0;
  signal_rows integer := 0;
  finish_rows integer := 0;
  snapshot_rows integer := 0;
begin
  latest_rows := public.refresh_variant_price_latest();
  daily_rows := public.refresh_variant_price_daily(greatest(lookback_days, 35));
  signal_rows := public.refresh_variant_signals_latest();
  finish_rows := public.refresh_set_finish_summary_latest(null);
  snapshot_rows := public.refresh_set_summary_snapshots(target_as_of_date, null);

  return jsonb_build_object(
    'variantPriceLatestRows', latest_rows,
    'variantPriceDailyRows', daily_rows,
    'variantSignalsLatestRows', signal_rows,
    'setFinishRows', finish_rows,
    'setSnapshotRows', snapshot_rows,
    'asOfDate', target_as_of_date
  );
end;
$$;

create or replace function public.refresh_set_summary_pipeline_for_variants(
  keys jsonb,
  target_as_of_date date default current_date,
  lookback_days integer default 35
)
returns jsonb
language plpgsql
as $$
declare
  latest_rows integer := 0;
  daily_rows integer := 0;
  signal_rows integer := 0;
  finish_rows integer := 0;
  snapshot_rows integer := 0;
  target_set_ids text[];
begin
  if coalesce(jsonb_array_length(coalesce(keys, '[]'::jsonb)), 0) = 0 then
    return jsonb_build_object(
      'variantPriceLatestRows', 0,
      'variantPriceDailyRows', 0,
      'variantSignalsLatestRows', 0,
      'setFinishRows', 0,
      'setSnapshotRows', 0,
      'asOfDate', target_as_of_date
    );
  end if;

  latest_rows := public.refresh_variant_price_latest_for_variants(keys);
  daily_rows := public.refresh_variant_price_daily_for_variants(keys, greatest(lookback_days, 35));
  signal_rows := public.refresh_variant_signals_latest_for_variants(keys);

  select array_agg(distinct set_id)
  into target_set_ids
  from public.variant_price_latest vpl
  join (
    select distinct
      item->>'provider' as provider,
      item->>'variant_ref' as variant_ref,
      coalesce(nullif(item->>'grade', ''), 'RAW') as grade
    from jsonb_array_elements(coalesce(keys, '[]'::jsonb)) item
    where coalesce(item->>'provider', '') <> ''
      and coalesce(item->>'variant_ref', '') <> ''
  ) k
    on k.provider = vpl.provider
   and k.variant_ref = vpl.variant_ref
   and k.grade = vpl.grade
  where vpl.set_id is not null;

  if target_set_ids is not null and array_length(target_set_ids, 1) > 0 then
    finish_rows := public.refresh_set_finish_summary_latest(target_set_ids);
    snapshot_rows := public.refresh_set_summary_snapshots(target_as_of_date, target_set_ids);
  end if;

  return jsonb_build_object(
    'variantPriceLatestRows', latest_rows,
    'variantPriceDailyRows', daily_rows,
    'variantSignalsLatestRows', signal_rows,
    'setFinishRows', finish_rows,
    'setSnapshotRows', snapshot_rows,
    'setIds', coalesce(target_set_ids, array[]::text[]),
    'asOfDate', target_as_of_date
  );
end;
$$;
