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
    from public.price_history_points ph
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

  with provider_latest as (
    select
      vm.canonical_slug,
      max(case when vm.provider = 'JUSTTCG' then vm.provider_as_of_ts end) as justtcg_as_of,
      max(case when vm.provider in ('SCRYDEX','POKEMON_TCG_API') then vm.provider_as_of_ts end) as scrydex_as_of
    from public.variant_metrics vm
    where vm.grade = 'RAW'
      and vm.printing_id is null
      and vm.provider in ('JUSTTCG','SCRYDEX','POKEMON_TCG_API')
      and vm.canonical_slug = any(p_canonical_slugs)
    group by vm.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider = 'JUSTTCG')::numeric as justtcg_points_7d,
      count(*) filter (where ph.provider in ('SCRYDEX','POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history_points ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('JUSTTCG','SCRYDEX','POKEMON_TCG_API')
      and ph.canonical_slug = any(p_canonical_slugs)
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
