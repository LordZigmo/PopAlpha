-- Promote exact PriceCharting matches to the trusted English RAW price layer.
--
-- PriceCharting product rows remain private. Public clients read only the
-- curated result through public_card_metrics.market_price and its provenance.

create table if not exists public.pricecharting_product_observations (
  id                 uuid        primary key default gen_random_uuid(),
  product_id         text        not null references public.pricecharting_products(product_id) on delete cascade,
  observed_on        date        not null,
  observed_at        timestamptz not null,
  loose_price_usd    numeric     not null check (loose_price_usd > 0),
  sales_volume       integer     null check (sales_volume is null or sales_volume >= 0),
  import_source      text        not null default 'csv' check (import_source in ('csv', 'api', 'manual')),
  raw_payload        jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists pricecharting_product_observations_product_day_uidx
  on public.pricecharting_product_observations (product_id, observed_on);

create index if not exists pricecharting_product_observations_product_at_idx
  on public.pricecharting_product_observations (product_id, observed_at desc);

create index if not exists pricecharting_product_observations_day_idx
  on public.pricecharting_product_observations (observed_on desc);

comment on table public.pricecharting_product_observations is
  'Private daily PriceCharting loose/raw observations. This is PopAlpha-owned '
  'history used for trusted 24h/7d movement once enough snapshots exist.';

create table if not exists public.canonical_trusted_raw_prices (
  id                                  uuid        primary key default gen_random_uuid(),
  canonical_slug                      text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id                         uuid        null references public.card_printings(id) on delete set null,
  product_id                          text        null references public.pricecharting_products(product_id) on delete set null,
  trusted_price_usd                   numeric     null check (trusted_price_usd is null or trusted_price_usd > 0),
  trusted_price_as_of                 timestamptz null,
  trusted_price_source                text        null check (trusted_price_source in ('PRICECHARTING', 'SCRYDEX')),
  trust_status                        text        not null default 'NO_TRUSTED_PRICE'
    check (trust_status in (
      'PRICECHARTING_PRIMARY',
      'PRICECHARTING_SCRYDEX_MATCH',
      'PRICECHARTING_DIVERGED',
      'SCRYDEX_ONLY_DEMOTED',
      'NO_TRUSTED_PRICE'
    )),
  pricecharting_price_usd             numeric     null check (pricecharting_price_usd is null or pricecharting_price_usd > 0),
  pricecharting_as_of                 timestamptz null,
  pricecharting_change_pct_24h        numeric     null,
  pricecharting_change_pct_7d         numeric     null,
  pricecharting_observations_7d       integer     not null default 0 check (pricecharting_observations_7d >= 0),
  pricecharting_history_points_30d    integer     not null default 0 check (pricecharting_history_points_30d >= 0),
  scrydex_price_usd                   numeric     null check (scrydex_price_usd is null or scrydex_price_usd > 0),
  scrydex_as_of                       timestamptz null,
  relative_delta_pct                  numeric     null,
  quarantine_reason                   text        null,
  metadata                            jsonb       not null default '{}'::jsonb,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now()
);

create unique index if not exists canonical_trusted_raw_prices_scope_uidx
  on public.canonical_trusted_raw_prices (canonical_slug, printing_id)
  nulls not distinct;

create index if not exists canonical_trusted_raw_prices_status_idx
  on public.canonical_trusted_raw_prices (trust_status, updated_at desc);

create index if not exists canonical_trusted_raw_prices_product_idx
  on public.canonical_trusted_raw_prices (product_id)
  where product_id is not null;

comment on table public.canonical_trusted_raw_prices is
  'Private trusted EN RAW price policy. Exact PriceCharting matches win; '
  'Scrydex remains legacy context and is demoted or quarantined on conflict.';

drop trigger if exists trg_pricecharting_product_observations_set_updated_at
  on public.pricecharting_product_observations;
create trigger trg_pricecharting_product_observations_set_updated_at
before update on public.pricecharting_product_observations
for each row execute function public.pricecharting_set_updated_at();

drop trigger if exists trg_canonical_trusted_raw_prices_set_updated_at
  on public.canonical_trusted_raw_prices;
create trigger trg_canonical_trusted_raw_prices_set_updated_at
before update on public.canonical_trusted_raw_prices
for each row execute function public.pricecharting_set_updated_at();

create or replace function public.refresh_canonical_trusted_raw_prices(
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
  with base_metrics as (
    select
      cm.canonical_slug,
      cm.printing_id,
      cm.grade,
      cc.language,
      cm.market_price,
      cm.market_price_as_of,
      cm.scrydex_price,
      cm.median_7d,
      cm.median_30d,
      cm.trimmed_median_30d,
      cm.low_30d,
      cm.snapshot_count_30d,
      cm.market_confidence_score,
      cm.market_low_confidence,
      cm.market_provenance,
      (
        cm.grade = 'RAW'
        and cm.market_price is not null
        and coalesce(cm.snapshot_count_30d, 0) >= 5
        and cm.market_price > (
          greatest(
            coalesce(nullif(cm.median_7d, 0), 0),
            coalesce(nullif(cm.median_30d, 0), 0),
            coalesce(nullif(cm.trimmed_median_30d, 0), 0),
            coalesce(nullif(cm.low_30d, 0), 0),
            1
          ) * 20
        )
      ) as raw_market_price_outlier
    from public.card_metrics cm
    join public.canonical_cards cc
      on cc.slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cc.language = 'EN'
  ),
  latest_observations as (
    select *
    from (
      select
        o.product_id,
        o.observed_at,
        o.loose_price_usd,
        o.sales_volume,
        row_number() over (
          partition by o.product_id
          order by o.observed_at desc, o.updated_at desc
        ) as rn
      from public.pricecharting_product_observations o
      where o.loose_price_usd > 0
    ) ranked
    where rn = 1
  ),
  pricecharting_history as (
    select
      latest.product_id,
      count(*) filter (
        where o.observed_at >= latest.observed_at - interval '7 days'
      )::integer as observations_7d,
      count(*) filter (
        where o.observed_at >= latest.observed_at - interval '30 days'
      )::integer as history_points_30d
    from latest_observations latest
    join public.pricecharting_product_observations o
      on o.product_id = latest.product_id
    group by latest.product_id
  ),
  pricecharting_changes as (
    select
      latest.product_id,
      latest.loose_price_usd,
      latest.observed_at,
      case
        when baseline_24h.loose_price_usd > 0
        then round(((latest.loose_price_usd - baseline_24h.loose_price_usd) / baseline_24h.loose_price_usd * 100)::numeric, 2)
        else null
      end as change_pct_24h,
      case
        when baseline_7d.loose_price_usd > 0
        then round(((latest.loose_price_usd - baseline_7d.loose_price_usd) / baseline_7d.loose_price_usd * 100)::numeric, 2)
        else null
      end as change_pct_7d
    from latest_observations latest
    left join lateral (
      select o.loose_price_usd
      from public.pricecharting_product_observations o
      where o.product_id = latest.product_id
        and o.observed_at <= latest.observed_at - interval '20 hours'
        and o.observed_at >= latest.observed_at - interval '48 hours'
        and o.loose_price_usd > 0
      order by o.observed_at desc
      limit 1
    ) baseline_24h on true
    left join lateral (
      select o.loose_price_usd
      from public.pricecharting_product_observations o
      where o.product_id = latest.product_id
        and o.observed_at <= latest.observed_at - interval '6 days'
        and o.observed_at >= latest.observed_at - interval '10 days'
        and o.loose_price_usd > 0
      order by o.observed_at desc
      limit 1
    ) baseline_7d on true
  ),
  matched_scopes as (
    select *
    from (
      select
        m.product_id,
        m.canonical_slug,
        scope.display_printing_id as printing_id,
        m.match_status,
        m.match_confidence,
        m.match_type,
        m.match_reason,
        m.identity,
        p.product_name,
        p.console_name,
        latest.loose_price_usd as pricecharting_price_usd,
        latest.observed_at as pricecharting_as_of,
        changes.change_pct_24h as pricecharting_change_pct_24h,
        changes.change_pct_7d as pricecharting_change_pct_7d,
        coalesce(history.observations_7d, 0) as pricecharting_observations_7d,
        coalesce(history.history_points_30d, 0) as pricecharting_history_points_30d,
        row_number() over (
          partition by m.canonical_slug, scope.display_printing_id
          order by
            coalesce(m.match_confidence, 0) desc,
            latest.observed_at desc,
            coalesce(latest.sales_volume, 0) desc,
            m.updated_at desc,
            m.product_id asc
        ) as rn
      from public.pricecharting_product_matches m
      join public.pricecharting_products p
        on p.product_id = m.product_id
      join latest_observations latest
        on latest.product_id = m.product_id
      left join pricecharting_changes changes
        on changes.product_id = m.product_id
      left join pricecharting_history history
        on history.product_id = m.product_id
      cross join lateral (
        select null::uuid as display_printing_id
        where m.identity->>'pricechartingHeadlineEligible' = 'true'

        union all

        select m.printing_id as display_printing_id
        where m.printing_id is not null
          and m.identity->>'pricechartingPrintingEligible' = 'true'
      ) scope
      where m.match_status = 'MATCHED'
        and m.canonical_slug is not null
        and latest.loose_price_usd > 0
    ) ranked
    where rn = 1
  ),
  joined as (
    select
      bm.canonical_slug,
      bm.printing_id,
      ms.product_id,
      ms.pricecharting_price_usd,
      ms.pricecharting_as_of,
      ms.pricecharting_change_pct_24h,
      ms.pricecharting_change_pct_7d,
      coalesce(ms.pricecharting_observations_7d, 0) as pricecharting_observations_7d,
      coalesce(ms.pricecharting_history_points_30d, 0) as pricecharting_history_points_30d,
      case
        when bm.raw_market_price_outlier then null
        else coalesce(bm.scrydex_price, bm.market_price)
      end as scrydex_price_usd,
      case
        when bm.raw_market_price_outlier then null
        else bm.market_price_as_of
      end as scrydex_as_of,
      bm.market_confidence_score,
      bm.market_low_confidence,
      bm.snapshot_count_30d,
      bm.market_provenance,
      ms.match_status,
      ms.match_confidence,
      ms.match_type,
      ms.match_reason,
      ms.product_name,
      ms.console_name,
      case
        when ms.pricecharting_price_usd is not null
         and coalesce(bm.scrydex_price, bm.market_price) is not null
         and not bm.raw_market_price_outlier
         and ((ms.pricecharting_price_usd + coalesce(bm.scrydex_price, bm.market_price)) / 2) > 0
        then round((abs(ms.pricecharting_price_usd - coalesce(bm.scrydex_price, bm.market_price)) / ((ms.pricecharting_price_usd + coalesce(bm.scrydex_price, bm.market_price)) / 2) * 100)::numeric, 2)
        else null
      end as relative_delta_pct,
      (
        ms.pricecharting_price_usd is not null
        and ms.pricecharting_as_of >= now() - make_interval(days => v_window_days)
      ) as has_fresh_pricecharting
    from base_metrics bm
    left join matched_scopes ms
      on ms.canonical_slug = bm.canonical_slug
     and ms.printing_id is not distinct from bm.printing_id
  ),
  classified as (
    select
      j.*,
      case
        when j.has_fresh_pricecharting
         and j.scrydex_price_usd is not null
         and j.relative_delta_pct is not null
         and (
           j.relative_delta_pct <= v_agreement_pct
           or abs(j.pricecharting_price_usd - j.scrydex_price_usd) <= 1
         )
          then 'PRICECHARTING_SCRYDEX_MATCH'
        when j.has_fresh_pricecharting
         and j.scrydex_price_usd is not null
          then 'PRICECHARTING_DIVERGED'
        when j.has_fresh_pricecharting
          then 'PRICECHARTING_PRIMARY'
        when j.scrydex_price_usd is not null
          then 'SCRYDEX_ONLY_DEMOTED'
        else 'NO_TRUSTED_PRICE'
      end as trust_status,
      case
        when j.has_fresh_pricecharting then j.pricecharting_price_usd
        when j.scrydex_price_usd is not null then j.scrydex_price_usd
        else null
      end as trusted_price_usd,
      case
        when j.has_fresh_pricecharting then j.pricecharting_as_of
        when j.scrydex_price_usd is not null then j.scrydex_as_of
        else null
      end as trusted_price_as_of,
      case
        when j.has_fresh_pricecharting then 'PRICECHARTING'
        when j.scrydex_price_usd is not null then 'SCRYDEX'
        else null
      end as trusted_price_source,
      case
        when j.has_fresh_pricecharting
         and j.scrydex_price_usd is not null
         and (
           j.relative_delta_pct is null
           or (
             j.relative_delta_pct > v_agreement_pct
             and abs(j.pricecharting_price_usd - j.scrydex_price_usd) > 1
           )
         )
          then 'SCRYDEX_DIVERGED_FROM_PRICECHARTING'
        when j.scrydex_price_usd is not null
         and j.pricecharting_price_usd is null
          then 'MISSING_PRICECHARTING_EXACT_MATCH'
        when j.scrydex_price_usd is not null
         and j.pricecharting_price_usd is not null
         and not j.has_fresh_pricecharting
          then 'PRICECHARTING_STALE_OR_MISSING'
        else null
      end as quarantine_reason
    from joined j
  )
  insert into public.canonical_trusted_raw_prices (
    canonical_slug,
    printing_id,
    product_id,
    trusted_price_usd,
    trusted_price_as_of,
    trusted_price_source,
    trust_status,
    pricecharting_price_usd,
    pricecharting_as_of,
    pricecharting_change_pct_24h,
    pricecharting_change_pct_7d,
    pricecharting_observations_7d,
    pricecharting_history_points_30d,
    scrydex_price_usd,
    scrydex_as_of,
    relative_delta_pct,
    quarantine_reason,
    metadata,
    updated_at
  )
  select
    canonical_slug,
    printing_id,
    product_id,
    trusted_price_usd,
    trusted_price_as_of,
    trusted_price_source,
    trust_status,
    pricecharting_price_usd,
    pricecharting_as_of,
    pricecharting_change_pct_24h,
    pricecharting_change_pct_7d,
    pricecharting_observations_7d,
    pricecharting_history_points_30d,
    scrydex_price_usd,
    scrydex_as_of,
    relative_delta_pct,
    quarantine_reason,
    jsonb_strip_nulls(jsonb_build_object(
      'matchStatus', match_status,
      'matchConfidence', match_confidence,
      'matchType', match_type,
      'matchReason', match_reason,
      'pricechartingProductName', product_name,
      'pricechartingConsoleName', console_name,
      'scrydexConfidenceScore', market_confidence_score,
      'scrydexLowConfidence', market_low_confidence,
      'scrydexSnapshotCount30d', snapshot_count_30d,
      'legacyScrydexProvenance', market_provenance
    )) as metadata,
    now()
  from classified
  on conflict (canonical_slug, printing_id) do update
    set
      product_id = excluded.product_id,
      trusted_price_usd = excluded.trusted_price_usd,
      trusted_price_as_of = excluded.trusted_price_as_of,
      trusted_price_source = excluded.trusted_price_source,
      trust_status = excluded.trust_status,
      pricecharting_price_usd = excluded.pricecharting_price_usd,
      pricecharting_as_of = excluded.pricecharting_as_of,
      pricecharting_change_pct_24h = excluded.pricecharting_change_pct_24h,
      pricecharting_change_pct_7d = excluded.pricecharting_change_pct_7d,
      pricecharting_observations_7d = excluded.pricecharting_observations_7d,
      pricecharting_history_points_30d = excluded.pricecharting_history_points_30d,
      scrydex_price_usd = excluded.scrydex_price_usd,
      scrydex_as_of = excluded.scrydex_as_of,
      relative_delta_pct = excluded.relative_delta_pct,
      quarantine_reason = excluded.quarantine_reason,
      metadata = excluded.metadata,
      updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace view public.public_card_metrics as
select
  cm.id,
  cm.canonical_slug,
  cm.printing_id,
  cm.grade,
  cm.median_7d,
  cm.median_30d,
  cm.low_30d,
  cm.high_30d,
  cm.trimmed_median_30d,
  cm.volatility_30d,
  cm.liquidity_score,
  cm.percentile_rank,
  cm.scarcity_adjusted_value,
  cm.active_listings_7d,
  cm.snapshot_count_30d,
  cm.provider_trend_slope_7d,
  cm.provider_trend_slope_30d,
  cm.provider_cov_price_7d,
  cm.provider_cov_price_30d,
  cm.provider_price_relative_to_30d_range,
  cm.provider_min_price_all_time,
  cm.provider_min_price_all_time_date,
  cm.provider_max_price_all_time,
  cm.provider_max_price_all_time_date,
  cm.provider_as_of_ts,
  cm.provider_price_changes_count_30d,
  cm.justtcg_price,
  case when cm.raw_market_price_outlier then null else cm.scrydex_price end as scrydex_price,
  case when cm.raw_market_price_outlier then null else cm.scrydex_price end as pokemontcg_price,
  coalesce(yjp_specific.price_usd, yjp_canonical.price_usd) as yahoo_jp_price,
  coalesce(yjp_specific.price_jpy, yjp_canonical.price_jpy) as yahoo_jp_price_jpy,
  coalesce(yjp_specific.sample_count, yjp_canonical.sample_count) as yahoo_jp_sample_count,
  coalesce(yjp_specific.observed_at, yjp_canonical.observed_at) as yahoo_jp_observed_at,
  coalesce(snk_specific.price_usd, snk_canonical.price_usd) as snkrdunk_price,
  coalesce(snk_specific.sample_count, snk_canonical.sample_count) as snkrdunk_sample_count,
  coalesce(snk_specific.observed_at, snk_canonical.observed_at) as snkrdunk_observed_at,
  coalesce(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) as snkrdunk_product_code,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when cm.raw_market_price_outlier then null
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED', 'SCRYDEX_ONLY_DEMOTED')
          then ctrp.trusted_price_usd
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then null
        else cm.market_price
      end
    when cm.raw_market_price_outlier then null
    else cm.market_price
  end as market_price,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when cm.raw_market_price_outlier then null
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED', 'SCRYDEX_ONLY_DEMOTED')
          then ctrp.trusted_price_as_of
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then null
        else cm.market_price_as_of
      end
    when cm.raw_market_price_outlier then null
    else cm.market_price_as_of
  end as market_price_as_of,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when cm.raw_market_price_outlier then null
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED', 'SCRYDEX_ONLY_DEMOTED')
          then ctrp.trusted_price_as_of
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then null
        else cm.provider_compare_as_of
      end
    when cm.raw_market_price_outlier then null
    else cm.provider_compare_as_of
  end as provider_compare_as_of,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when cm.raw_market_price_outlier then 0
        when ctrp.trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 96
        when ctrp.trust_status = 'PRICECHARTING_PRIMARY' then 92
        when ctrp.trust_status = 'PRICECHARTING_DIVERGED' then 85
        when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then 25
        when ctrp.trust_status = 'NO_TRUSTED_PRICE' then 0
        when cm.market_price is not null then least(coalesce(cm.market_confidence_score, 20), 25)
        else 0
      end
    when cm.raw_market_price_outlier then 0
    else cm.market_confidence_score
  end as market_confidence_score,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when cm.raw_market_price_outlier then true
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED') then false
        else true
      end
    when cm.raw_market_price_outlier then true
    else cm.market_low_confidence
  end as market_low_confidence,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when cm.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
        when ctrp.trust_status is not null then ctrp.trust_status
        when cm.market_price is not null then 'SCRYDEX_ONLY_DEMOTED'
        else 'NO_TRUSTED_PRICE'
      end
    when cm.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
    else cm.market_blend_policy
  end as market_blend_policy,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      jsonb_strip_nulls(jsonb_build_object(
        'trustedPriceSource',
          case
            when ctrp.trusted_price_source is not null then ctrp.trusted_price_source
            when cm.raw_market_price_outlier then null
            when cm.market_price is not null then 'SCRYDEX'
            else null
          end,
        'trustStatus',
          case
            when cm.raw_market_price_outlier then 'NO_TRUSTED_PRICE'
            when ctrp.trust_status is not null then ctrp.trust_status
            when cm.market_price is not null then 'SCRYDEX_ONLY_DEMOTED'
            else 'NO_TRUSTED_PRICE'
          end,
        'priceConflictStatus',
          case
            when ctrp.trust_status = 'PRICECHARTING_DIVERGED' then 'DIVERGED'
            when ctrp.trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 'MATCHED'
            when ctrp.trust_status = 'SCRYDEX_ONLY_DEMOTED' then 'SCRYDEX_ONLY'
            else 'NONE'
          end,
        'relativeDeltaPct', ctrp.relative_delta_pct,
        'priceAsOf',
          case
            when ctrp.trusted_price_as_of is not null then ctrp.trusted_price_as_of
            when cm.raw_market_price_outlier then null
            else cm.market_price_as_of
          end,
        'pricechartingAsOf', ctrp.pricecharting_as_of,
        'scrydexAsOf',
          case
            when ctrp.scrydex_as_of is not null then ctrp.scrydex_as_of
            when cm.raw_market_price_outlier then null
            else cm.market_price_as_of
          end,
        'movementHistorySource',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
             and (ctrp.pricecharting_change_pct_24h is not null or ctrp.pricecharting_change_pct_7d is not null)
              then 'PRICECHARTING'
            else null
          end,
        'pricechartingObservations7d', ctrp.pricecharting_observations_7d,
        'pricechartingHistoryPoints30d', ctrp.pricecharting_history_points_30d,
        'quarantineReason',
          case
            when ctrp.quarantine_reason is not null then ctrp.quarantine_reason
            when ctrp.trust_status is null and cm.market_price is not null and not cm.raw_market_price_outlier
              then 'MISSING_PRICECHARTING_EXACT_MATCH'
            else null
          end,
        'parityStatus',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
             and (ctrp.pricecharting_change_pct_24h is not null or ctrp.pricecharting_change_pct_7d is not null)
              then 'MATCH'
            else 'MISSING_PROVIDER'
          end,
        'sourceMix',
          case
            when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
              then jsonb_build_object('pricechartingWeight', 1, 'scrydexWeight', 0)
            when cm.market_price is not null and not cm.raw_market_price_outlier
              then jsonb_build_object('pricechartingWeight', 0, 'scrydexWeight', 1)
            else jsonb_build_object('pricechartingWeight', 0, 'scrydexWeight', 0)
          end,
        'sampleCounts7d',
          jsonb_build_object(
            'pricecharting', coalesce(ctrp.pricecharting_observations_7d, 0),
            'scrydex',
              case
                when coalesce(cm.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                  then (cm.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                else 0
              end
          ),
        'legacyScrydexProvenance', cm.market_provenance
      ))
    when cm.raw_market_price_outlier then coalesce(cm.market_provenance, '{}'::jsonb) || jsonb_build_object('parityStatus', 'MISSING_PROVIDER')
    else cm.market_provenance
  end as market_provenance,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.pricecharting_change_pct_24h
        else null
      end
    when cm.raw_market_price_outlier then null
    else cm.change_pct_24h
  end as change_pct_24h,
  case
    when cc.language = 'EN' and cm.grade = 'RAW' then
      case
        when ctrp.trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_SCRYDEX_MATCH', 'PRICECHARTING_DIVERGED')
          then ctrp.pricecharting_change_pct_7d
        else null
      end
    when cm.raw_market_price_outlier then null
    else cm.change_pct_7d
  end as change_pct_7d,
  cm.updated_at,
  cc.canonical_name_native,
  cc.set_name_native,
  cc.language,
  coalesce(snk_specific.price_jpy, snk_canonical.price_jpy) as snkrdunk_price_jpy
from (
  select
    base_cm.*,
    (
      base_cm.grade = 'RAW'
      and base_cm.market_price is not null
      and coalesce(base_cm.snapshot_count_30d, 0) >= 5
      and base_cm.market_price > (
        greatest(
          coalesce(nullif(base_cm.median_7d, 0), 0),
          coalesce(nullif(base_cm.median_30d, 0), 0),
          coalesce(nullif(base_cm.trimmed_median_30d, 0), 0),
          coalesce(nullif(base_cm.low_30d, 0), 0),
          1
        ) * 20
      )
    ) as raw_market_price_outlier
  from public.card_metrics base_cm
) cm
left join public.yahoo_jp_card_prices yjp_specific
  on yjp_specific.canonical_slug = cm.canonical_slug
 and yjp_specific.printing_id = cm.printing_id
 and yjp_specific.grade = cm.grade
left join public.yahoo_jp_card_prices yjp_canonical
  on yjp_canonical.canonical_slug = cm.canonical_slug
 and yjp_canonical.printing_id is null
 and yjp_canonical.grade = cm.grade
left join public.snkrdunk_card_prices snk_specific
  on snk_specific.canonical_slug = cm.canonical_slug
 and snk_specific.printing_id = cm.printing_id
 and snk_specific.grade = cm.grade
left join public.snkrdunk_card_prices snk_canonical
  on snk_canonical.canonical_slug = cm.canonical_slug
 and snk_canonical.printing_id is null
 and snk_canonical.grade = cm.grade
left join public.canonical_cards cc
  on cc.slug = cm.canonical_slug
left join public.canonical_trusted_raw_prices ctrp
  on ctrp.canonical_slug = cm.canonical_slug
 and ctrp.printing_id is not distinct from cm.printing_id;

grant select on public.public_card_metrics to anon, authenticated;

alter table public.pricecharting_product_observations enable row level security;
alter table public.canonical_trusted_raw_prices enable row level security;

revoke all on table public.pricecharting_product_observations from public, anon, authenticated;
revoke all on table public.canonical_trusted_raw_prices from public, anon, authenticated;

grant select, insert, update, delete on table public.pricecharting_product_observations to service_role;
grant select, insert, update, delete on table public.canonical_trusted_raw_prices to service_role;

revoke execute on function public.refresh_canonical_trusted_raw_prices(integer, numeric) from public, anon, authenticated;
grant execute on function public.refresh_canonical_trusted_raw_prices(integer, numeric) to service_role;
