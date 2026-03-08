-- Align market confidence and canonical market price with the live snapshot
-- pipeline. Canonical RAW freshness currently lives in price_snapshots /
-- price_history_points, not in canonical variant_metrics rows.

create or replace function public.refresh_card_market_confidence()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected integer := 0;
begin
  with provider_latest_raw as (
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end
    )
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.observed_at
    from public.price_snapshots ps
    where ps.grade = 'RAW'
      and ps.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ps.observed_at >= now() - interval '30 days'
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  provider_latest_canonical as (
    select
      pl.canonical_slug,
      max(case when pl.provider_key = 'JUSTTCG' then pl.observed_at end) as justtcg_as_of,
      max(case when pl.provider_key = 'SCRYDEX' then pl.observed_at end) as scrydex_as_of
    from provider_latest pl
    where pl.grade = 'RAW'
      and pl.printing_id is null
    group by pl.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
      count(*) filter (where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history_points ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
    group by ph.canonical_slug
  ),
  base as (
    select
      cm.id,
      cm.canonical_slug,
      cm.justtcg_price,
      cm.scrydex_price,
      cm.market_price as current_market_price,
      cm.market_price_as_of as current_market_price_as_of,
      cm.median_7d,
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
    left join provider_latest_canonical pl
      on pl.canonical_slug = cm.canonical_slug
    left join provider_counts pc
      on pc.canonical_slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cm.printing_id is null
  ),
  weighted as (
    select
      b.*,
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
      as w_scrydex,

      (b.justtcg_as_of is not null and now() - b.justtcg_as_of > interval '168 hours') as justtcg_stale,
      (b.scrydex_as_of is not null and now() - b.scrydex_as_of > interval '168 hours') as scrydex_stale,
      (b.ratio is not null and b.ratio >= 3.5 and b.justtcg_price > b.scrydex_price) as justtcg_outlier,
      (b.ratio is not null and b.ratio >= 3.5 and b.scrydex_price > b.justtcg_price) as scrydex_outlier
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
      end as source_mix_scrydex,
      case
        when w.justtcg_stale then 'STALE'
        when w.justtcg_outlier then 'OUTLIER'
        else null
      end as justtcg_excluded_reason,
      case
        when w.scrydex_stale then 'STALE'
        when w.scrydex_outlier then 'OUTLIER'
        else null
      end as scrydex_excluded_reason
    from weighted w
  ),
  scored as (
    select
      n.*,
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
        when n.justtcg_price is null and n.scrydex_price is null then round(coalesce(n.current_market_price, n.median_7d)::numeric, 4)
        when n.justtcg_price is null then round(n.scrydex_price::numeric, 4)
        when n.scrydex_price is null then round(n.justtcg_price::numeric, 4)
        when n.w_total <= 0.01 then round(coalesce(n.justtcg_price, n.scrydex_price, n.current_market_price, n.median_7d)::numeric, 4)
        else round(((n.justtcg_price * n.w_justtcg + n.scrydex_price * n.w_scrydex) / nullif(n.w_total, 0))::numeric, 4)
      end as resolved_market_price,
      case
        when n.justtcg_price is null and n.scrydex_price is null then coalesce(n.current_market_price_as_of, n.justtcg_as_of, n.scrydex_as_of)
        when n.justtcg_price is null then coalesce(n.scrydex_as_of, n.current_market_price_as_of)
        when n.scrydex_price is null then coalesce(n.justtcg_as_of, n.current_market_price_as_of)
        else greatest(n.justtcg_as_of, n.scrydex_as_of)
      end as resolved_market_price_as_of,
      case
        when n.justtcg_as_of is null and n.scrydex_as_of is null then n.current_market_price_as_of
        else greatest(n.justtcg_as_of, n.scrydex_as_of)
      end as resolved_provider_compare_as_of
    from normalized n
  ),
  updates as (
    select
      s.id,
      s.resolved_market_price as market_price,
      s.resolved_market_price_as_of as market_price_as_of,
      s.resolved_provider_compare_as_of as provider_compare_as_of,
      s.confidence_score,
      (
        s.confidence_score < 45
        or s.justtcg_price is null
        or s.scrydex_price is null
        or s.w_total <= 0.01
      ) as low_confidence,
      case
        when s.justtcg_price is null and s.scrydex_price is null then
          case
            when s.resolved_market_price is null then 'NO_PRICE'
            else 'SINGLE_PROVIDER'
          end
        when s.justtcg_price is null or s.scrydex_price is null then 'SINGLE_PROVIDER'
        when s.w_total <= 0.01 then 'FALLBACK_STALE_OR_OUTLIER'
        when s.justtcg_excluded_reason is not null or s.scrydex_excluded_reason is not null then 'FALLBACK_STALE_OR_OUTLIER'
        else 'TRUST_WEIGHTED_BLEND'
      end as blend_policy,
      jsonb_build_object(
        'sourceMix', jsonb_build_object(
          'justtcgWeight', round((case when s.w_total > 0 then s.source_mix_justtcg else 0 end)::numeric, 4),
          'scrydexWeight', round((case when s.w_total > 0 then s.source_mix_scrydex else 0 end)::numeric, 4)
        ),
        'providerWeights', jsonb_build_array(
          jsonb_build_object(
            'provider', 'JUSTTCG',
            'weight', round((case when s.w_total > 0 then s.source_mix_justtcg else 0 end)::numeric, 4),
            'trustScore', round((least(1, greatest(0, s.w_justtcg)) * 100)::numeric, 0),
            'freshnessHours', case
              when s.justtcg_as_of is null then null
              else round((extract(epoch from (now() - s.justtcg_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', s.justtcg_points_7d,
            'lastUpdate', s.justtcg_as_of,
            'excludedReason', s.justtcg_excluded_reason
          ),
          jsonb_build_object(
            'provider', 'SCRYDEX',
            'weight', round((case when s.w_total > 0 then s.source_mix_scrydex else 0 end)::numeric, 4),
            'trustScore', round((least(1, greatest(0, s.w_scrydex)) * 100)::numeric, 0),
            'freshnessHours', case
              when s.scrydex_as_of is null then null
              else round((extract(epoch from (now() - s.scrydex_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', s.scrydex_points_7d,
            'lastUpdate', s.scrydex_as_of,
            'excludedReason', s.scrydex_excluded_reason
          )
        ),
        'providerDivergencePct', round(coalesce(s.divergence_pct, 0)::numeric, 2),
        'sampleCounts7d', jsonb_build_object(
          'justtcg', s.justtcg_points_7d,
          'scrydex', s.scrydex_points_7d
        ),
        'parityStatus', coalesce(s.parity_status, 'UNKNOWN')
      ) as provenance
    from scored s
  )
  update public.card_metrics cm
  set
    market_price = u.market_price,
    market_price_as_of = u.market_price_as_of,
    provider_compare_as_of = u.provider_compare_as_of,
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

create or replace function public.refresh_card_market_confidence_for_cards(p_canonical_slugs text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected integer := 0;
begin
  if p_canonical_slugs is null or coalesce(array_length(p_canonical_slugs, 1), 0) = 0 then
    return jsonb_build_object(
      'ok', true,
      'affected', 0
    );
  end if;

  with provider_latest_raw as (
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end
    )
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.observed_at
    from public.price_snapshots ps
    where ps.grade = 'RAW'
      and ps.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(p_canonical_slugs)
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  provider_latest_canonical as (
    select
      pl.canonical_slug,
      max(case when pl.provider_key = 'JUSTTCG' then pl.observed_at end) as justtcg_as_of,
      max(case when pl.provider_key = 'SCRYDEX' then pl.observed_at end) as scrydex_as_of
    from provider_latest pl
    where pl.grade = 'RAW'
      and pl.printing_id is null
    group by pl.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
      count(*) filter (where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history_points ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('JUSTTCG', 'SCRYDEX', 'POKEMON_TCG_API')
      and ph.canonical_slug = any(p_canonical_slugs)
    group by ph.canonical_slug
  ),
  base as (
    select
      cm.id,
      cm.canonical_slug,
      cm.justtcg_price,
      cm.scrydex_price,
      cm.market_price as current_market_price,
      cm.market_price_as_of as current_market_price_as_of,
      cm.median_7d,
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
    left join provider_latest_canonical pl
      on pl.canonical_slug = cm.canonical_slug
    left join provider_counts pc
      on pc.canonical_slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cm.printing_id is null
      and cm.canonical_slug = any(p_canonical_slugs)
  ),
  weighted as (
    select
      b.*,
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
      as w_scrydex,

      (b.justtcg_as_of is not null and now() - b.justtcg_as_of > interval '168 hours') as justtcg_stale,
      (b.scrydex_as_of is not null and now() - b.scrydex_as_of > interval '168 hours') as scrydex_stale,
      (b.ratio is not null and b.ratio >= 3.5 and b.justtcg_price > b.scrydex_price) as justtcg_outlier,
      (b.ratio is not null and b.ratio >= 3.5 and b.scrydex_price > b.justtcg_price) as scrydex_outlier
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
      end as source_mix_scrydex,
      case
        when w.justtcg_stale then 'STALE'
        when w.justtcg_outlier then 'OUTLIER'
        else null
      end as justtcg_excluded_reason,
      case
        when w.scrydex_stale then 'STALE'
        when w.scrydex_outlier then 'OUTLIER'
        else null
      end as scrydex_excluded_reason
    from weighted w
  ),
  scored as (
    select
      n.*,
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
        when n.justtcg_price is null and n.scrydex_price is null then round(coalesce(n.current_market_price, n.median_7d)::numeric, 4)
        when n.justtcg_price is null then round(n.scrydex_price::numeric, 4)
        when n.scrydex_price is null then round(n.justtcg_price::numeric, 4)
        when n.w_total <= 0.01 then round(coalesce(n.justtcg_price, n.scrydex_price, n.current_market_price, n.median_7d)::numeric, 4)
        else round(((n.justtcg_price * n.w_justtcg + n.scrydex_price * n.w_scrydex) / nullif(n.w_total, 0))::numeric, 4)
      end as resolved_market_price,
      case
        when n.justtcg_price is null and n.scrydex_price is null then coalesce(n.current_market_price_as_of, n.justtcg_as_of, n.scrydex_as_of)
        when n.justtcg_price is null then coalesce(n.scrydex_as_of, n.current_market_price_as_of)
        when n.scrydex_price is null then coalesce(n.justtcg_as_of, n.current_market_price_as_of)
        else greatest(n.justtcg_as_of, n.scrydex_as_of)
      end as resolved_market_price_as_of,
      case
        when n.justtcg_as_of is null and n.scrydex_as_of is null then n.current_market_price_as_of
        else greatest(n.justtcg_as_of, n.scrydex_as_of)
      end as resolved_provider_compare_as_of
    from normalized n
  ),
  updates as (
    select
      s.id,
      s.resolved_market_price as market_price,
      s.resolved_market_price_as_of as market_price_as_of,
      s.resolved_provider_compare_as_of as provider_compare_as_of,
      s.confidence_score,
      (
        s.confidence_score < 45
        or s.justtcg_price is null
        or s.scrydex_price is null
        or s.w_total <= 0.01
      ) as low_confidence,
      case
        when s.justtcg_price is null and s.scrydex_price is null then
          case
            when s.resolved_market_price is null then 'NO_PRICE'
            else 'SINGLE_PROVIDER'
          end
        when s.justtcg_price is null or s.scrydex_price is null then 'SINGLE_PROVIDER'
        when s.w_total <= 0.01 then 'FALLBACK_STALE_OR_OUTLIER'
        when s.justtcg_excluded_reason is not null or s.scrydex_excluded_reason is not null then 'FALLBACK_STALE_OR_OUTLIER'
        else 'TRUST_WEIGHTED_BLEND'
      end as blend_policy,
      jsonb_build_object(
        'sourceMix', jsonb_build_object(
          'justtcgWeight', round((case when s.w_total > 0 then s.source_mix_justtcg else 0 end)::numeric, 4),
          'scrydexWeight', round((case when s.w_total > 0 then s.source_mix_scrydex else 0 end)::numeric, 4)
        ),
        'providerWeights', jsonb_build_array(
          jsonb_build_object(
            'provider', 'JUSTTCG',
            'weight', round((case when s.w_total > 0 then s.source_mix_justtcg else 0 end)::numeric, 4),
            'trustScore', round((least(1, greatest(0, s.w_justtcg)) * 100)::numeric, 0),
            'freshnessHours', case
              when s.justtcg_as_of is null then null
              else round((extract(epoch from (now() - s.justtcg_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', s.justtcg_points_7d,
            'lastUpdate', s.justtcg_as_of,
            'excludedReason', s.justtcg_excluded_reason
          ),
          jsonb_build_object(
            'provider', 'SCRYDEX',
            'weight', round((case when s.w_total > 0 then s.source_mix_scrydex else 0 end)::numeric, 4),
            'trustScore', round((least(1, greatest(0, s.w_scrydex)) * 100)::numeric, 0),
            'freshnessHours', case
              when s.scrydex_as_of is null then null
              else round((extract(epoch from (now() - s.scrydex_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', s.scrydex_points_7d,
            'lastUpdate', s.scrydex_as_of,
            'excludedReason', s.scrydex_excluded_reason
          )
        ),
        'providerDivergencePct', round(coalesce(s.divergence_pct, 0)::numeric, 2),
        'sampleCounts7d', jsonb_build_object(
          'justtcg', s.justtcg_points_7d,
          'scrydex', s.scrydex_points_7d
        ),
        'parityStatus', coalesce(s.parity_status, 'UNKNOWN')
      ) as provenance
    from scored s
  )
  update public.card_metrics cm
  set
    market_price = u.market_price,
    market_price_as_of = u.market_price_as_of,
    provider_compare_as_of = u.provider_compare_as_of,
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
