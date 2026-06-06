-- Scrub all JustTCG residue from the provider-parity subsystem.
--
-- JustTCG is a fully-retired provider: ingestion stopped 2026-03-09 and the
-- last JUSTTCG observation in every source table predates the 30-day parity
-- window, so the JUSTTCG arms of these functions have produced NULL for every
-- in-window row since ~April. PRs #180/#181 removed the active app-side and
-- card_metrics.justtcg_price residue; this migration completes the cleanup by
-- (1) rewriting the three functions that still mention the dead justtcg_*
-- columns and (2) dropping those now-unreferenced columns from
-- canonical_raw_provider_parity.
--
-- canonical_raw_provider_parity is read ONLY by refresh_card_market_confidence_core
-- and written ONLY by the two parity refresh functions below; no views or
-- matviews depend on it, so once these three functions stop referencing the
-- justtcg_* columns the column drop is clean.
--
-- Behavioral equivalence note (parity_status): removing the justtcg (`j`) join
-- forces the parity_status CASE to collapse. With no in-window JUSTTCG data the
-- `j` side is always NULL, so the live CASE already only yields 'UNKNOWN' (no
-- scrydex) or 'MISSING_PROVIDER' (scrydex present); the 'MATCH'/'MISMATCH' arms
-- are unreachable dead code. The collapsed CASE reproduces the live function's
-- output for every executable row. (A handful of stale 'MATCH'/'MISMATCH' rows
-- last refreshed 2026-03-17 will be corrected to 'MISSING_PROVIDER' on their
-- next refresh — which the current live function would also do.)
--
-- CREATE OR REPLACE FUNCTION preserves owner, EXECUTE grants, and the
-- SET search_path config; all three are re-stated in the bodies below to match
-- the live definitions exactly, so privileges and search_path are unchanged.
--
-- supersedes: 20260307031000_canonical_raw_provider_parity.sql               (refresh_canonical_raw_provider_parity)
-- supersedes: 20260307183000_targeted_pipeline_refreshes.sql                 (refresh_canonical_raw_provider_parity_for_cards)
-- supersedes: 20260317093000_phase1_public_live_market_truth_followup.sql    (refresh_card_market_confidence_core)

-- 1) refresh_canonical_raw_provider_parity(integer): drop the JUSTTCG arm,
--    the j join, the 5 justtcg_* derived/insert/select/conflict columns.
CREATE OR REPLACE FUNCTION public.refresh_canonical_raw_provider_parity(p_window_days integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_rows integer := 0;
begin
  with matched as (
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
    where m.match_status = 'MATCHED'
      and m.canonical_slug is not null
      and m.provider = 'SCRYDEX'
      and o.observed_price is not null
      and o.observed_at >= now() - make_interval(days => greatest(1, coalesce(p_window_days, 30)))
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
  ),
  joined as (
    select
      c.slug as canonical_slug,
      s.normalized_finish as scrydex_finish,
      s.normalized_edition as scrydex_edition,
      s.normalized_stamp as scrydex_stamp,
      coalesce(s.points_30d, 0) as scrydex_points_30d,
      s.latest_observed_at as scrydex_as_of,
      case
        when s.canonical_slug is null then 'UNKNOWN'
        else 'MISSING_PROVIDER'
      end as parity_status
    from public.canonical_cards c
    left join provider_top s
      on s.canonical_slug = c.slug and s.provider = 'SCRYDEX'
  )
  insert into public.canonical_raw_provider_parity (
    canonical_slug,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    updated_at
  )
  select
    canonical_slug,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    now()
  from joined
  on conflict (canonical_slug) do update
    set
      scrydex_finish = excluded.scrydex_finish,
      scrydex_edition = excluded.scrydex_edition,
      scrydex_stamp = excluded.scrydex_stamp,
      scrydex_points_30d = excluded.scrydex_points_30d,
      scrydex_as_of = excluded.scrydex_as_of,
      parity_status = excluded.parity_status,
      updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

-- 2) refresh_canonical_raw_provider_parity_for_cards(text[], integer): same
--    treatment as (1), mirrored.
CREATE OR REPLACE FUNCTION public.refresh_canonical_raw_provider_parity_for_cards(p_canonical_slugs text[], p_window_days integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_rows integer := 0;
begin
  if p_canonical_slugs is null or coalesce(array_length(p_canonical_slugs, 1), 0) = 0 then
    return 0;
  end if;

  with matched as (
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
    where m.match_status = 'MATCHED'
      and m.canonical_slug is not null
      and m.canonical_slug = any(p_canonical_slugs)
      and m.provider = 'SCRYDEX'
      and o.observed_price is not null
      and o.observed_at >= now() - make_interval(days => greatest(1, coalesce(p_window_days, 30)))
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
  ),
  joined as (
    select
      c.slug as canonical_slug,
      s.normalized_finish as scrydex_finish,
      s.normalized_edition as scrydex_edition,
      s.normalized_stamp as scrydex_stamp,
      coalesce(s.points_30d, 0) as scrydex_points_30d,
      s.latest_observed_at as scrydex_as_of,
      case
        when s.canonical_slug is null then 'UNKNOWN'
        else 'MISSING_PROVIDER'
      end as parity_status
    from public.canonical_cards c
    left join provider_top s
      on s.canonical_slug = c.slug and s.provider = 'SCRYDEX'
    where c.slug = any(p_canonical_slugs)
  )
  insert into public.canonical_raw_provider_parity (
    canonical_slug,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    updated_at
  )
  select
    canonical_slug,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    now()
  from joined
  on conflict (canonical_slug) do update
    set
      scrydex_finish = excluded.scrydex_finish,
      scrydex_edition = excluded.scrydex_edition,
      scrydex_stamp = excluded.scrydex_stamp,
      scrydex_points_30d = excluded.scrydex_points_30d,
      scrydex_as_of = excluded.scrydex_as_of,
      parity_status = excluded.parity_status,
      updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

-- 3) refresh_card_market_confidence_core(text[]): remove all 12 dead justtcg
--    lines (null/0 aliases, 'justtcgWeight'/'justtcg' JSON keys). It reads only
--    p.parity_status from canonical_raw_provider_parity — never a justtcg_*
--    column — so it no longer references any column being dropped.
CREATE OR REPLACE FUNCTION public.refresh_card_market_confidence_core(p_canonical_slugs text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      and ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ps.observed_at >= now() - interval '72 hours'
      and (
        p_canonical_slugs is null
        or ps.canonical_slug = any(p_canonical_slugs)
      )
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
      max(case when pl.provider_key = 'SCRYDEX' then pl.observed_at end) as scrydex_as_of
    from provider_latest pl
    where pl.grade = 'RAW'
      and pl.printing_id is null
    group by pl.canonical_slug
  ),
  provider_counts as (
    select
      ph.canonical_slug,
      count(*) filter (where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API'))::numeric as scrydex_points_7d
    from public.price_history_points ph
    where ph.source_window = 'snapshot'
      and ph.ts >= now() - interval '7 days'
      and ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and (
        p_canonical_slugs is null
        or ph.canonical_slug = any(p_canonical_slugs)
      )
    group by ph.canonical_slug
  ),
  base as (
    select
      cm.id,
      cm.canonical_slug,
      cm.scrydex_price,
      cm.market_price as current_market_price,
      cm.market_price_as_of as current_market_price_as_of,
      cm.median_7d,
      p.parity_status,
      pl.scrydex_as_of,
      coalesce(pc.scrydex_points_7d, 0) as scrydex_points_7d,
      null::numeric as divergence_pct,
      null::numeric as ratio
    from public.card_metrics cm
    left join public.canonical_raw_provider_parity p
      on p.canonical_slug = cm.canonical_slug
    left join provider_latest_canonical pl
      on pl.canonical_slug = cm.canonical_slug
    left join provider_counts pc
      on pc.canonical_slug = cm.canonical_slug
    where cm.grade = 'RAW'
      and cm.printing_id is null
      and (
        p_canonical_slugs is null
        or cm.canonical_slug = any(p_canonical_slugs)
      )
  ),
  weighted as (
    select
      b.*,
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
      as w_scrydex,
      (b.scrydex_as_of is not null and now() - b.scrydex_as_of > interval '168 hours') as scrydex_stale,
      false as scrydex_outlier
    from base b
  ),
  normalized as (
    select
      w.*,
      w.w_scrydex as w_total,
      case
        when w.w_scrydex > 0 then 1::numeric
        else 0::numeric
      end as source_mix_scrydex,
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
        when n.scrydex_price is null then 0
        else round(((
          0.55 * 0.25 +
          (1 - least(1, coalesce(extract(epoch from (now() - n.scrydex_as_of)) / 3600.0, 36) / 168.0)) * 0.25 +
          0.5 * 0.3 +
          (case when n.parity_status = 'MATCH' then 1 when n.parity_status = 'UNKNOWN' then 0.7 else 0.4 end) * 0.2
        ) * 100)::numeric, 0)
      end as confidence_score,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then round(n.scrydex_price::numeric, 4)
        else null
      end as resolved_market_price,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then coalesce(n.current_market_price_as_of, n.scrydex_as_of)
        else null
      end as resolved_market_price_as_of,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then n.scrydex_as_of
        else null
      end as resolved_provider_compare_as_of,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then 'SCRYDEX'
        else null
      end as selected_provider,
      case
        when n.scrydex_price is not null and n.scrydex_excluded_reason is null then 'SCRYDEX_PRIMARY'
        else 'NO_PRICE'
      end as resolved_blend_policy
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
        s.resolved_market_price is null
        or s.confidence_score < 45
        or s.resolved_blend_policy = 'NO_PRICE'
      ) as low_confidence,
      s.resolved_blend_policy as blend_policy,
      jsonb_build_object(
        'selectedProvider', s.selected_provider,
        'sourceMix', jsonb_build_object(
          'scrydexWeight', case when s.selected_provider = 'SCRYDEX' then 1 else 0 end
        ),
        'providerWeights', jsonb_build_array(
          jsonb_build_object(
            'provider', 'SCRYDEX',
            'weight', case when s.selected_provider = 'SCRYDEX' then 1 else 0 end,
            'trustScore', case
              when s.selected_provider = 'SCRYDEX' then round((least(1, greatest(0, s.w_scrydex)) * 100)::numeric, 0)
              else 0
            end,
            'freshnessHours', case
              when s.selected_provider <> 'SCRYDEX' or s.scrydex_as_of is null then null
              else round((extract(epoch from (now() - s.scrydex_as_of)) / 3600.0)::numeric, 2)
            end,
            'points7d', case when s.selected_provider = 'SCRYDEX' then s.scrydex_points_7d else 0 end,
            'lastUpdate', case when s.selected_provider = 'SCRYDEX' then s.scrydex_as_of else null end,
            'excludedReason', case when s.selected_provider = 'SCRYDEX' then s.scrydex_excluded_reason else null end
          )
        ),
        'providerDivergencePct', null,
        'sampleCounts7d', jsonb_build_object(
          'scrydex', case when s.selected_provider = 'SCRYDEX' then s.scrydex_points_7d else 0 end
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
$function$;

-- 4) Now that no function references them, drop the dead justtcg_* columns.
--    canonical_raw_provider_parity has no dependent views/matviews, so this is
--    a clean drop.
alter table public.canonical_raw_provider_parity
  drop column if exists justtcg_finish,
  drop column if exists justtcg_edition,
  drop column if exists justtcg_stamp,
  drop column if exists justtcg_points_30d,
  drop column if exists justtcg_as_of;
