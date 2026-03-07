alter table public.card_metrics
  add column if not exists market_confidence_score numeric,
  add column if not exists market_low_confidence boolean,
  add column if not exists market_blend_policy text,
  add column if not exists market_provenance jsonb;

create table if not exists public.realized_sales_backtest_snapshots (
  id bigserial primary key,
  captured_at timestamptz not null default now(),
  sample_size integer not null default 0,
  mae numeric,
  mape numeric,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists realized_sales_backtest_snapshots_captured_at_idx
  on public.realized_sales_backtest_snapshots (captured_at desc);

create table if not exists public.pricing_alert_events (
  id bigserial primary key,
  event_key text not null,
  severity text not null check (severity in ('warning', 'critical')),
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  delivered_to text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (event_key, severity)
);

create index if not exists pricing_alert_events_created_at_idx
  on public.pricing_alert_events (created_at desc);

create or replace function public.refresh_card_market_confidence()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected integer := 0;
begin
  with provider_latest as (
    select
      vm.canonical_slug,
      max(case when vm.provider = 'JUSTTCG' then vm.provider_as_of_ts end) as justtcg_as_of,
      max(case when vm.provider in ('SCRYDEX','POKEMON_TCG_API') then vm.provider_as_of_ts end) as scrydex_as_of
    from public.variant_metrics vm
    where vm.grade = 'RAW'
      and vm.printing_id is null
      and vm.provider in ('JUSTTCG','SCRYDEX','POKEMON_TCG_API')
    group by vm.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
      count(*) filter (where ph.provider in ('SCRYDEX','POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('JUSTTCG','SCRYDEX','POKEMON_TCG_API')
    group by ph.canonical_slug
  ),
  base as (
    select
      cm.id,
      cm.canonical_slug,
      cm.justtcg_price,
      cm.scrydex_price,
      p.parity_status,
      pl.justtcg_as_of,
      pl.scrydex_as_of,
      coalesce(pc.justtcg_points_7d, 0) as justtcg_points_7d,
      coalesce(pc.scrydex_points_7d, 0) as scrydex_points_7d,
      case
        when cm.justtcg_price is not null and cm.scrydex_price is not null and (cm.justtcg_price + cm.scrydex_price) > 0
          then abs(cm.justtcg_price - cm.scrydex_price) / ((cm.justtcg_price + cm.scrydex_price) / 2) * 100
        else null
      end as divergence_pct,
      case
        when cm.justtcg_price is not null and cm.scrydex_price is not null and least(cm.justtcg_price, cm.scrydex_price) > 0
          then greatest(cm.justtcg_price, cm.scrydex_price) / least(cm.justtcg_price, cm.scrydex_price)
        else null
      end as ratio
    from public.card_metrics cm
    left join public.canonical_raw_provider_parity p
      on p.canonical_slug = cm.canonical_slug
    left join provider_latest pl
      on pl.canonical_slug = cm.canonical_slug
    left join provider_counts pc
      on pc.canonical_slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cm.printing_id is null
  ),
  weighted as (
    select
      b.*,
      -- Freshness + activity weighted trust inputs
      (case when b.justtcg_price is null then 0 else 1 end)
      * (case
          when b.justtcg_as_of is null then 0.55
          when now() - b.justtcg_as_of <= interval '3 hours' then 1
          when now() - b.justtcg_as_of <= interval '6 hours' then 0.95
          when now() - b.justtcg_as_of <= interval '24 hours' then 0.85
          when now() - b.justtcg_as_of <= interval '72 hours' then 0.6
          when now() - b.justtcg_as_of <= interval '168 hours' then 0.35
          else 0.15
        end)
      * (0.4 + least(1, b.justtcg_points_7d / 80.0) * 0.6)
      * (case when b.parity_status = 'MATCH' then 1 when b.parity_status = 'UNKNOWN' then 0.92 else 0.72 end)
      * (case when b.divergence_pct is null then 1 else greatest(0.25, 1 - least(0.75, b.divergence_pct / 220.0)) end)
      * (case when b.ratio is not null and b.ratio >= 3.5 and b.justtcg_price > b.scrydex_price then 0.03 else 1 end)
      * (case when b.justtcg_as_of is not null and now() - b.justtcg_as_of > interval '168 hours' then 0.05 else 1 end)
      as w_justtcg,

      (case when b.scrydex_price is null then 0 else 0.96 end)
      * (case
          when b.scrydex_as_of is null then 0.55
          when now() - b.scrydex_as_of <= interval '3 hours' then 1
          when now() - b.scrydex_as_of <= interval '6 hours' then 0.95
          when now() - b.scrydex_as_of <= interval '24 hours' then 0.85
          when now() - b.scrydex_as_of <= interval '72 hours' then 0.6
          when now() - b.scrydex_as_of <= interval '168 hours' then 0.35
          else 0.15
        end)
      * (0.4 + least(1, b.scrydex_points_7d / 80.0) * 0.6)
      * (case when b.parity_status = 'MATCH' then 1 when b.parity_status = 'UNKNOWN' then 0.92 else 0.72 end)
      * (case when b.divergence_pct is null then 1 else greatest(0.25, 1 - least(0.75, b.divergence_pct / 220.0)) end)
      * (case when b.ratio is not null and b.ratio >= 3.5 and b.scrydex_price > b.justtcg_price then 0.03 else 1 end)
      * (case when b.scrydex_as_of is not null and now() - b.scrydex_as_of > interval '168 hours' then 0.05 else 1 end)
      as w_scrydex
    from base b
  ),
  normalized as (
    select
      w.*,
      (w.w_justtcg + w.w_scrydex) as w_total,
      case
        when (w.w_justtcg + w.w_scrydex) > 0 then w.w_justtcg / (w.w_justtcg + w.w_scrydex)
        else 0
      end as source_mix_justtcg,
      case
        when (w.w_justtcg + w.w_scrydex) > 0 then w.w_scrydex / (w.w_justtcg + w.w_scrydex)
        else 0
      end as source_mix_scrydex
    from weighted w
  ),
  updates as (
    select
      n.id,
      case
        when n.justtcg_price is null and n.scrydex_price is null then 0
        else round(((
          (case when n.justtcg_price is not null and n.scrydex_price is not null then 1 else 0.55 end) * 0.25 +
          (case
            when n.w_total <= 0 then 0
            else (
              n.source_mix_justtcg * (1 - least(1, coalesce(extract(epoch from (now() - n.justtcg_as_of)) / 3600.0, 36) / 168.0)) +
              n.source_mix_scrydex * (1 - least(1, coalesce(extract(epoch from (now() - n.scrydex_as_of)) / 3600.0, 36) / 168.0))
            )
          end) * 0.25 +
          (case when n.divergence_pct is null then 0.5 else greatest(0, 1 - least(1, n.divergence_pct / 120.0)) end) * 0.3 +
          (case when n.parity_status = 'MATCH' then 1 when n.parity_status = 'UNKNOWN' then 0.7 else 0.4 end) * 0.2
        ) * 100)::numeric, 0)
      end as confidence_score,
      case
        when n.justtcg_price is null and n.scrydex_price is null then true
        when n.justtcg_price is null or n.scrydex_price is null then true
        when n.w_total <= 0.01 then true
        else false
      end as low_confidence,
      case
        when n.justtcg_price is null and n.scrydex_price is null then 'NO_PRICE'
        when n.justtcg_price is null or n.scrydex_price is null then 'SINGLE_PROVIDER'
        when n.w_total <= 0.01 then 'FALLBACK_STALE_OR_OUTLIER'
        when (n.ratio is not null and n.ratio >= 3.5) then 'FALLBACK_STALE_OR_OUTLIER'
        else 'TRUST_WEIGHTED_BLEND'
      end as blend_policy,
      jsonb_build_object(
        'sourceMix', jsonb_build_object(
          'justtcgWeight', round((n.source_mix_justtcg)::numeric, 4),
          'scrydexWeight', round((n.source_mix_scrydex)::numeric, 4)
        ),
        'providerWeights', jsonb_build_array(
          jsonb_build_object(
            'provider', 'JUSTTCG',
            'weight', round((case when n.w_total > 0 then n.source_mix_justtcg else 0 end)::numeric, 4),
            'points7d', n.justtcg_points_7d,
            'lastUpdate', n.justtcg_as_of
          ),
          jsonb_build_object(
            'provider', 'SCRYDEX',
            'weight', round((case when n.w_total > 0 then n.source_mix_scrydex else 0 end)::numeric, 4),
            'points7d', n.scrydex_points_7d,
            'lastUpdate', n.scrydex_as_of
          )
        ),
        'providerDivergencePct', round(coalesce(n.divergence_pct, 0)::numeric, 2),
        'sampleCounts7d', jsonb_build_object(
          'justtcg', n.justtcg_points_7d,
          'scrydex', n.scrydex_points_7d
        ),
        'parityStatus', coalesce(n.parity_status, 'UNKNOWN')
      ) as provenance
    from normalized n
  )
  update public.card_metrics cm
  set
    market_confidence_score = u.confidence_score,
    market_low_confidence = u.low_confidence,
    market_blend_policy = u.blend_policy,
    market_provenance = u.provenance,
    updated_at = now()
  from updates u
  where cm.id = u.id;

  get diagnostics v_affected = row_count;

  return jsonb_build_object(
    'ok', true,
    'affected', v_affected
  );
end;
$$;

create or replace function public.refresh_realized_sales_backtest()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sample_size integer := 0;
  v_mae numeric := null;
  v_mape numeric := null;
  v_payload jsonb := '{}'::jsonb;
begin
  with mapped_sales as (
    select
      ps.id,
      ps.cert,
      ps.sold_at,
      case
        when upper(coalesce(ps.currency, 'USD')) = 'USD' then ps.price
        else ps.price
      end as sold_price_usd,
      h.canonical_slug,
      coalesce(nullif(h.grade, ''), 'RAW') as grade,
      cc.year,
      coalesce(cm.active_listings_7d, 0) as active_listings_7d
    from public.private_sales ps
    join lateral (
      select h.canonical_slug, h.grade
      from public.holdings h
      where h.cert_number = ps.cert
      order by h.created_at desc nulls last
      limit 1
    ) h on true
    left join public.canonical_cards cc
      on cc.slug = h.canonical_slug
    left join public.card_metrics cm
      on cm.canonical_slug = h.canonical_slug
     and cm.printing_id is null
     and cm.grade = coalesce(nullif(h.grade, ''), 'RAW')
    where ps.price is not null
      and ps.price > 0
      and ps.sold_at >= now() - interval '180 days'
  ),
  realized as (
    select
      ms.canonical_slug,
      ms.grade,
      percentile_cont(0.5) within group (order by ms.sold_price_usd) as realized_price,
      min(ms.year) as year,
      min(ms.active_listings_7d) as active_listings_7d,
      count(*)::integer as sales_count
    from mapped_sales ms
    group by ms.canonical_slug, ms.grade
  ),
  joined as (
    select
      cm.canonical_slug,
      cm.grade,
      cm.market_price,
      r.realized_price,
      r.sales_count,
      r.year,
      r.active_listings_7d,
      abs(cm.market_price - r.realized_price) as abs_err,
      case when r.realized_price > 0 then abs(cm.market_price - r.realized_price) / r.realized_price * 100 else null end as pct_err
    from public.card_metrics cm
    join realized r
      on r.canonical_slug = cm.canonical_slug
     and r.grade = cm.grade
    where cm.printing_id is null
      and cm.market_price is not null
      and r.realized_price is not null
      and r.realized_price > 0
  ),
  totals as (
    select
      count(*)::integer as sample_size,
      avg(abs_err)::numeric as mae,
      avg(pct_err)::numeric as mape
    from joined
  ),
  segmented as (
    select
      (case when coalesce(year, 9999) <= 2004 then 'vintage' else 'modern' end)
      || '/'
      || (case when grade = 'RAW' then 'raw' else 'graded' end)
      || '/'
      || (case when active_listings_7d <= 4 then 'low-liquidity' else 'high-liquidity' end) as segment,
      count(*)::integer as sample_size,
      avg(abs_err)::numeric as mae,
      avg(pct_err)::numeric as mape
    from joined
    group by 1
    order by count(*) desc
  ),
  linkage as (
    select
      (select count(*)::integer from public.private_sales ps where ps.sold_at >= now() - interval '180 days') as total_sales_180d,
      (select count(*)::integer from mapped_sales) as mapped_sales_180d,
      (select count(*)::integer from mapped_sales where canonical_slug is null) as unmapped_sales_180d
  )
  select
    t.sample_size,
    round(t.mae, 4),
    round(t.mape, 2),
    jsonb_build_object(
      'sampleSize', t.sample_size,
      'mae', round(t.mae, 4),
      'mape', round(t.mape, 2),
      'bySegment', coalesce((
        select jsonb_agg(jsonb_build_object(
          'segment', s.segment,
          'sampleSize', s.sample_size,
          'mae', round(s.mae, 4),
          'mape', round(s.mape, 2)
        ) order by s.sample_size desc)
        from segmented s
      ), '[]'::jsonb),
      'linkage', (
        select jsonb_build_object(
          'totalSales180d', l.total_sales_180d,
          'mappedSales180d', l.mapped_sales_180d,
          'unmappedSales180d', greatest(0, l.total_sales_180d - l.mapped_sales_180d)
        )
        from linkage l
      )
    )
  into v_sample_size, v_mae, v_mape, v_payload
  from totals t;

  insert into public.realized_sales_backtest_snapshots (sample_size, mae, mape, payload)
  values (coalesce(v_sample_size, 0), v_mae, v_mape, coalesce(v_payload, '{}'::jsonb));

  delete from public.realized_sales_backtest_snapshots
  where captured_at < now() - interval '30 days';

  return jsonb_build_object(
    'ok', true,
    'sampleSize', coalesce(v_sample_size, 0),
    'mae', v_mae,
    'mape', v_mape
  );
end;
$$;

drop view if exists public.public_card_metrics;
create view public.public_card_metrics as
select
  id, canonical_slug, printing_id, grade,
  median_7d, median_30d, low_30d, high_30d, trimmed_median_30d,
  volatility_30d, liquidity_score, percentile_rank, scarcity_adjusted_value,
  active_listings_7d, snapshot_count_30d,
  provider_trend_slope_7d, provider_trend_slope_30d,
  provider_cov_price_7d, provider_cov_price_30d,
  provider_price_relative_to_30d_range,
  provider_min_price_all_time, provider_min_price_all_time_date,
  provider_max_price_all_time, provider_max_price_all_time_date,
  provider_as_of_ts,
  provider_price_changes_count_30d,
  justtcg_price,
  scrydex_price,
  scrydex_price as pokemontcg_price,
  market_price,
  market_price_as_of,
  provider_compare_as_of,
  market_confidence_score,
  market_low_confidence,
  market_blend_policy,
  market_provenance,
  change_pct_24h,
  change_pct_7d,
  updated_at
from public.card_metrics;

grant select on public.public_card_metrics to anon, authenticated;
