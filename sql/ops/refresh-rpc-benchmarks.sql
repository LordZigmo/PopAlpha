-- Refresh RPC benchmark and EXPLAIN follow-up.
-- Run one block at a time in the Supabase SQL editor or psql.
--
-- The function-level EXPLAIN ANALYZE blocks are wrapped in BEGIN/ROLLBACK so
-- they measure execution without persisting writes.

create temporary table if not exists benchmark_card_scope (
  canonical_slug text primary key
) on commit preserve rows;

truncate benchmark_card_scope;

-- Default cohort: 25 canonical RAW cards with the freshest market timestamps.
-- Re-run the INSERT with limit 100 and 400 for medium and large cohorts.
insert into benchmark_card_scope (canonical_slug)
select cm.canonical_slug
from public.card_metrics cm
where cm.grade = 'RAW'
  and cm.printing_id is null
  and cm.market_price_as_of is not null
order by cm.market_price_as_of desc, cm.canonical_slug asc
limit 25;

select
  count(*) as benchmark_slug_count,
  min(canonical_slug) as first_slug,
  max(canonical_slug) as last_slug
from benchmark_card_scope;

-- 1) Function-level benchmark: refresh_card_metrics_for_variants
begin;
set local statement_timeout = 0;
explain (analyze, buffers, wal, settings, summary)
select public.refresh_card_metrics_for_variants(
  coalesce(
    (
      select jsonb_agg(jsonb_build_object('canonical_slug', canonical_slug) order by canonical_slug)
      from benchmark_card_scope
    ),
    '[]'::jsonb
  )
);
rollback;

-- 2) Function-level benchmark: refresh_price_changes_for_cards
begin;
set local statement_timeout = 0;
explain (analyze, buffers, wal, settings, summary)
select public.refresh_price_changes_for_cards(
  coalesce(
    (
      select array_agg(canonical_slug order by canonical_slug)
      from benchmark_card_scope
    ),
    array[]::text[]
  )
);
rollback;

-- 3) Function-level benchmark: refresh_card_market_confidence_for_cards
begin;
set local statement_timeout = 0;
explain (analyze, buffers, wal, settings, summary)
select public.refresh_card_market_confidence_for_cards(
  coalesce(
    (
      select array_agg(canonical_slug order by canonical_slug)
      from benchmark_card_scope
    ),
    array[]::text[]
  )
);
rollback;

-- 4) Function-level benchmark: refresh_canonical_raw_provider_parity_for_cards
begin;
set local statement_timeout = 0;
explain (analyze, buffers, wal, settings, summary)
select public.refresh_canonical_raw_provider_parity_for_cards(
  coalesce(
    (
      select array_agg(canonical_slug order by canonical_slug)
      from benchmark_card_scope
    ),
    array[]::text[]
  ),
  30
);
rollback;

-- 5) EXPLAIN target: refresh_price_changes_for_cards heavy read path
explain (analyze, buffers, wal, settings, summary)
with benchmark_scope as (
  select coalesce(
    (
      select array_agg(canonical_slug order by canonical_slug)
      from benchmark_card_scope
    ),
    array[]::text[]
  ) as slugs
),
canonical_scope as (
  select distinct on (cm.canonical_slug)
    cm.canonical_slug,
    cm.scrydex_price as current_scrydex_price,
    cm.justtcg_price as current_justtcg_price,
    pref.id as preferred_printing_id,
    pref.finish as preferred_finish,
    pref.edition as preferred_edition,
    pref.stamp as preferred_stamp
  from public.card_metrics cm
  left join public.card_printings pref
    on pref.id = public.preferred_canonical_raw_printing(cm.canonical_slug)
  cross join benchmark_scope bs
  where cm.printing_id is null
    and cm.grade = 'RAW'
    and cm.canonical_slug = any(bs.slugs)
  order by cm.canonical_slug, cm.updated_at desc, cm.id desc
),
base_points as (
  select
    ph.canonical_slug,
    case
      when ph.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
      else ph.provider
    end as provider_key,
    ph.variant_ref,
    ph.ts,
    ph.price,
    case
      when ph.source_window = 'snapshot' then 1
      when ph.source_window = '7d' then 2
      when ph.source_window = '30d' then 3
      else 9
    end::int as source_priority,
    ph.source_window
  from public.price_history_points ph
  join canonical_scope cs
    on cs.canonical_slug = ph.canonical_slug
  where ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
    and ph.source_window in ('snapshot', '7d', '30d')
    and ph.ts >= now() - interval '14 days'
    and ph.price is not null
    and ph.price > 0
    and (
      cs.preferred_printing_id is null
      or split_part(ph.variant_ref, '::', 1) = cs.preferred_printing_id::text
    )
),
provider_candidates as (
  select
    bp.canonical_slug,
    bp.provider_key,
    max(bp.ts) as latest_ts,
    count(*) filter (where bp.source_window = 'snapshot' and bp.ts >= now() - interval '8 days')::integer as recent_snapshot_points,
    count(*) filter (where bp.ts >= now() - interval '8 days')::integer as recent_points,
    count(*)::integer as total_points
  from base_points bp
  group by bp.canonical_slug, bp.provider_key
),
preferred_provider as (
  select distinct on (pc.canonical_slug)
    pc.canonical_slug,
    pc.provider_key,
    case
      when pc.provider_key = 'SCRYDEX' then cs.current_scrydex_price
      else cs.current_justtcg_price
    end as current_provider_price
  from provider_candidates pc
  join canonical_scope cs
    on cs.canonical_slug = pc.canonical_slug
  order by
    pc.canonical_slug,
    case
      when cs.current_scrydex_price is not null and pc.provider_key = 'SCRYDEX' then 5
      when cs.current_justtcg_price is not null and pc.provider_key = 'JUSTTCG' then 5
      when pc.recent_snapshot_points > 0 then 4
      when pc.recent_points > 0 then 3
      when pc.total_points > 0 then 1
      else 0
    end desc,
    case when pc.provider_key = 'SCRYDEX' then 1 else 0 end desc,
    pc.latest_ts desc
),
variant_latest_points as (
  select distinct on (bp.canonical_slug, bp.provider_key, bp.variant_ref)
    bp.canonical_slug,
    bp.provider_key,
    bp.variant_ref,
    bp.ts as latest_ts,
    bp.price as latest_price,
    bp.source_priority
  from base_points bp
  join preferred_provider pp
    on pp.canonical_slug = bp.canonical_slug
   and pp.provider_key = bp.provider_key
  order by
    bp.canonical_slug,
    bp.provider_key,
    bp.variant_ref,
    bp.ts desc,
    bp.source_priority asc
),
preferred_variant as (
  select distinct on (vlp.canonical_slug)
    vlp.canonical_slug,
    vlp.provider_key,
    vlp.variant_ref
  from variant_latest_points vlp
  join preferred_provider pp
    on pp.canonical_slug = vlp.canonical_slug
   and pp.provider_key = vlp.provider_key
  join canonical_scope cs
    on cs.canonical_slug = vlp.canonical_slug
  order by
    vlp.canonical_slug,
    public.provider_variant_match_score(
      vlp.provider_key,
      vlp.variant_ref,
      cs.preferred_finish,
      cs.preferred_edition,
      cs.preferred_stamp
    ) desc,
    case when vlp.latest_ts >= now() - interval '8 days' then 2 else 1 end desc,
    case
      when pp.current_provider_price is not null
        then abs(vlp.latest_price - pp.current_provider_price)
      else 0
    end asc,
    vlp.source_priority asc,
    vlp.latest_ts desc
),
preferred_points as (
  select bp.*
  from base_points bp
  join preferred_variant pv
    on pv.canonical_slug = bp.canonical_slug
   and pv.provider_key = bp.provider_key
   and pv.variant_ref = bp.variant_ref
),
hourly_source_rank as (
  select
    pp.canonical_slug,
    date_trunc('hour', pp.ts) as bucket_ts,
    pp.source_priority,
    avg(pp.price)::numeric as canonical_price,
    count(*)::integer as points_in_bucket,
    max(pp.ts) as latest_point_ts
  from preferred_points pp
  group by pp.canonical_slug, date_trunc('hour', pp.ts), pp.source_priority
),
hourly_points as (
  select distinct on (hsr.canonical_slug, hsr.bucket_ts)
    hsr.canonical_slug,
    hsr.bucket_ts,
    hsr.canonical_price,
    hsr.points_in_bucket,
    hsr.source_priority,
    hsr.latest_point_ts
  from hourly_source_rank hsr
  order by
    hsr.canonical_slug,
    hsr.bucket_ts,
    hsr.source_priority asc,
    hsr.latest_point_ts desc,
    hsr.points_in_bucket desc
)
select
  count(*) as hourly_bucket_count,
  max(bucket_ts) as latest_bucket_ts
from hourly_points;

-- 6) EXPLAIN target: refresh_card_metrics_for_variants history_counts path
explain (analyze, buffers, wal, settings, summary)
with target_sets as (
  select array_agg(distinct coalesce(cp.set_name, cc.set_name)) as set_names
  from benchmark_card_scope b
  join public.canonical_cards cc
    on cc.slug = b.canonical_slug
  left join public.card_printings cp
    on cp.id = public.preferred_canonical_raw_printing(b.canonical_slug)
  where coalesce(cp.set_name, cc.set_name) is not null
),
history_points_expanded as (
  select
    ph.canonical_slug,
    case
      when split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then split_part(ph.variant_ref, '::', 1)::uuid
      else null::uuid
    end as printing_id,
    'RAW'::text as grade,
    ph.ts
  from public.price_history_points ph
  where ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
    and ph.source_window in ('snapshot', '30d')
    and ph.ts >= now() - interval '30 days'
),
history_points_filtered as (
  select
    hpe.canonical_slug,
    hpe.printing_id,
    hpe.grade,
    hpe.ts
  from history_points_expanded hpe
  join public.canonical_cards cc
    on cc.slug = hpe.canonical_slug
  left join public.card_printings cp
    on cp.id = hpe.printing_id
  cross join target_sets ts
  where coalesce(cp.set_name, cc.set_name) = any(ts.set_names)
),
history_counts as (
  select
    canonical_slug,
    printing_id,
    grade,
    count(*) filter (where ts >= now() - interval '7 days')::integer as history_7d_count,
    count(*)::integer as history_count_30d
  from (
    select canonical_slug, printing_id, grade, ts
    from history_points_filtered
    union all
    select canonical_slug, null::uuid as printing_id, grade, ts
    from history_points_filtered
    where printing_id is not null
  ) x
  group by canonical_slug, printing_id, grade
)
select
  count(*) as history_cohort_rows,
  max(history_count_30d) as max_history_points_30d
from history_counts;

-- 7) EXPLAIN target: refresh_card_market_confidence_for_cards provider_counts path
explain (analyze, buffers, wal, settings, summary)
with benchmark_scope as (
  select coalesce(
    (
      select array_agg(canonical_slug order by canonical_slug)
      from benchmark_card_scope
    ),
    array[]::text[]
  ) as slugs
),
provider_counts as (
  select
    ph.canonical_slug,
    count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
    count(*) filter (where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API'))::numeric as scrydex_points_7d
  from public.price_history_points ph
  cross join benchmark_scope bs
  where ph.source_window = 'snapshot'
    and ph.ts >= now() - interval '7 days'
    and ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
    and ph.canonical_slug = any(bs.slugs)
  group by ph.canonical_slug
)
select
  count(*) as provider_count_rows,
  sum(justtcg_points_7d + scrydex_points_7d) as total_points_7d
from provider_counts;

-- 8) EXPLAIN target: refresh_canonical_raw_provider_parity_for_cards join path
explain (analyze, buffers, wal, settings, summary)
with benchmark_scope as (
  select coalesce(
    (
      select array_agg(canonical_slug order by canonical_slug)
      from benchmark_card_scope
    ),
    array[]::text[]
  ) as slugs
),
matched as (
  select
    m.canonical_slug,
    m.provider,
    coalesce(o.normalized_finish, 'UNKNOWN') as normalized_finish,
    coalesce(o.normalized_edition, 'UNLIMITED') as normalized_edition,
    coalesce(o.normalized_stamp, 'NONE') as normalized_stamp,
    o.observed_at
  from public.provider_observation_matches m
  join public.provider_normalized_observations o
    on o.id = m.provider_normalized_observation_id
   and o.provider = m.provider
  cross join benchmark_scope bs
  where m.match_status = 'MATCHED'
    and m.canonical_slug = any(bs.slugs)
    and m.provider in ('JUSTTCG', 'SCRYDEX')
    and o.observed_price is not null
    and o.observed_at >= now() - interval '30 days'
),
profile_counts as (
  select
    canonical_slug,
    provider,
    normalized_finish,
    normalized_edition,
    normalized_stamp,
    count(*)::integer as points_30d,
    max(observed_at) as latest_observed_at
  from matched
  group by canonical_slug, provider, normalized_finish, normalized_edition, normalized_stamp
),
provider_top as (
  select *
  from (
    select
      pc.*,
      row_number() over (
        partition by pc.canonical_slug, pc.provider
        order by pc.points_30d desc, pc.latest_observed_at desc
      ) as rn
    from profile_counts pc
  ) ranked
  where rn = 1
)
select
  count(*) as provider_top_rows,
  max(latest_observed_at) as freshest_point
from provider_top;
