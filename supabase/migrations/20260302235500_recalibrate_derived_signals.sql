-- 20260302235500_recalibrate_derived_signals.sql
--
-- Recalibrates derived variant signals so the stored values match the UI and
-- ranking contract: bounded 0-100 scores instead of raw ratios.
--
-- Trend:
--   risk-adjusted momentum, centered at 50 and shrunk by sample depth
-- Breakout:
--   positive momentum only, scaled by activity and room to run
-- Value:
--   discount-to-range, penalized for illiquid penny prices

create or replace function public.refresh_derived_signals()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  with preferred_windows as (
    select
      vm.id,
      vm.canonical_slug,
      vm.variant_ref,
      vm.provider,
      vm.grade,
      vm.provider_trend_slope_7d,
      vm.provider_cov_price_30d,
      vm.provider_price_relative_to_30d_range,
      vm.provider_price_changes_count_30d,
      public.preferred_signal_history_window(vm.provider, vm.variant_ref) as selected_window
    from public.variant_metrics vm
    where vm.provider = 'JUSTTCG'
  ),
  history_counts as (
    select
      pw.id,
      pw.selected_window,
      count(php.*)::integer as sample_points
    from preferred_windows pw
    left join public.price_history_points php
      on php.canonical_slug = pw.canonical_slug
     and php.variant_ref = pw.variant_ref
     and php.provider = pw.provider
     and php.source_window = pw.selected_window
    group by pw.id, pw.selected_window
  ),
  signal_inputs as (
    select
      pw.id,
      pw.selected_window,
      coalesce(hc.sample_points, 0) as sample_points,
      pw.provider_trend_slope_7d,
      pw.provider_cov_price_30d,
      greatest(coalesce(vpl.price_value, 0), 0.25)::numeric as price_anchor,
      greatest(coalesce(pw.provider_cov_price_30d, 0), 0.08)::numeric as cov_anchor,
      least(greatest(coalesce(pw.provider_price_relative_to_30d_range, 0.5), 0), 1)::numeric as range_position,
      least(
        ln(1 + least(greatest(coalesce(pw.provider_price_changes_count_30d, 0), 0), 12)::numeric) / ln(13::numeric),
        1
      )::numeric as activity_score,
      case
        when coalesce(hc.sample_points, 0) > 0
        then sqrt(least(coalesce(hc.sample_points, 0), 45)::numeric / 45)
        else 0::numeric
      end as sample_confidence
    from preferred_windows pw
    left join history_counts hc
      on hc.id = pw.id
    left join public.variant_price_latest vpl
      on vpl.provider = pw.provider
     and vpl.variant_ref = pw.variant_ref
     and vpl.grade = pw.grade
  ),
  scored as (
    select
      si.id,
      case
        when si.selected_window is null then 0
        else si.sample_points
      end as history_points_30d,
      case
        when si.selected_window is not null
         and si.sample_points >= 10
         and si.provider_trend_slope_7d is not null
         and si.provider_cov_price_30d is not null
        then round((
          least(
            greatest(
              50 + 50 * tanh((
                ((((si.provider_trend_slope_7d)::numeric / si.price_anchor) / si.cov_anchor) * 6 * si.sample_confidence)::double precision
              )),
              0
            ),
            100
          )
        )::numeric, 1)
        else null
      end as signal_trend,
      case
        when si.selected_window is not null
         and si.sample_points >= 10
         and si.provider_trend_slope_7d is not null
        then round((
          least(
            greatest(
              100 * tanh((
                (
                  greatest((((si.provider_trend_slope_7d)::numeric / si.price_anchor) / si.cov_anchor), 0)
                  * (0.55 + 0.45 * si.activity_score)
                  * (0.5 + 0.5 * si.sample_confidence)
                  * (1 - si.range_position)
                  * 2.8
                )::double precision
              )),
              0
            ),
            100
          )
        )::numeric, 1)
        else null
      end as signal_breakout,
      case
        when si.selected_window is not null
         and si.sample_points >= 10
        then round((
          least(
            greatest(
              (
                power(1 - si.range_position, 1.15)
                * (0.35 + 0.65 * si.sample_confidence)
                * (0.25 + 0.75 * si.activity_score)
                * sqrt(least(si.price_anchor / 2.0, 1))
                * 100
              ),
              0
            ),
            100
          )
        )::numeric, 1)
        else null
      end as signal_value,
      case
        when si.selected_window is not null
         and si.sample_points >= 10 then now()
        else null
      end as signals_as_of_ts
    from signal_inputs si
  )
  update public.variant_metrics vm
  set
    history_points_30d = s.history_points_30d,
    signal_trend = s.signal_trend,
    signal_breakout = s.signal_breakout,
    signal_value = s.signal_value,
    signals_as_of_ts = s.signals_as_of_ts,
    updated_at = now()
  from scored s
  where vm.id = s.id;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok', true,
    'rowsUpdated', affected
  );
end;
$$;

create or replace function public.refresh_derived_signals_for_variants(keys jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  if keys is null or jsonb_typeof(keys) <> 'array' or jsonb_array_length(keys) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rowsUpdated', 0
    );
  end if;

  with target_keys as (
    select distinct
      nullif(trim(k.canonical_slug), '') as canonical_slug,
      nullif(trim(k.variant_ref), '') as variant_ref,
      nullif(trim(k.provider), '') as provider,
      nullif(trim(k.grade), '') as grade
    from jsonb_to_recordset(keys) as k(
      canonical_slug text,
      variant_ref text,
      provider text,
      grade text
    )
  ),
  preferred_windows as (
    select
      vm.id,
      tk.canonical_slug,
      tk.variant_ref,
      tk.provider,
      tk.grade,
      vm.provider_trend_slope_7d,
      vm.provider_cov_price_30d,
      vm.provider_price_relative_to_30d_range,
      vm.provider_price_changes_count_30d,
      public.preferred_signal_history_window(tk.provider, tk.variant_ref) as selected_window
    from target_keys tk
    join public.variant_metrics vm
      on vm.canonical_slug = tk.canonical_slug
     and vm.variant_ref = tk.variant_ref
     and vm.provider = tk.provider
     and vm.grade = tk.grade
    where tk.canonical_slug is not null
      and tk.variant_ref is not null
      and tk.provider is not null
      and tk.grade is not null
  ),
  history_counts as (
    select
      pw.id,
      pw.selected_window,
      count(php.*)::integer as sample_points
    from preferred_windows pw
    left join public.price_history_points php
      on php.canonical_slug = pw.canonical_slug
     and php.variant_ref = pw.variant_ref
     and php.provider = pw.provider
     and php.source_window = pw.selected_window
    group by pw.id, pw.selected_window
  ),
  signal_inputs as (
    select
      pw.id,
      pw.selected_window,
      coalesce(hc.sample_points, 0) as sample_points,
      pw.provider_trend_slope_7d,
      pw.provider_cov_price_30d,
      greatest(coalesce(vpl.price_value, 0), 0.25)::numeric as price_anchor,
      greatest(coalesce(pw.provider_cov_price_30d, 0), 0.08)::numeric as cov_anchor,
      least(greatest(coalesce(pw.provider_price_relative_to_30d_range, 0.5), 0), 1)::numeric as range_position,
      least(
        ln(1 + least(greatest(coalesce(pw.provider_price_changes_count_30d, 0), 0), 12)::numeric) / ln(13::numeric),
        1
      )::numeric as activity_score,
      case
        when coalesce(hc.sample_points, 0) > 0
        then sqrt(least(coalesce(hc.sample_points, 0), 45)::numeric / 45)
        else 0::numeric
      end as sample_confidence
    from preferred_windows pw
    left join history_counts hc
      on hc.id = pw.id
    left join public.variant_price_latest vpl
      on vpl.provider = pw.provider
     and vpl.variant_ref = pw.variant_ref
     and vpl.grade = pw.grade
  ),
  scored as (
    select
      si.id,
      case
        when si.selected_window is null then 0
        else si.sample_points
      end as history_points_30d,
      case
        when si.selected_window is not null
         and si.sample_points >= 10
         and si.provider_trend_slope_7d is not null
         and si.provider_cov_price_30d is not null
        then round((
          least(
            greatest(
              50 + 50 * tanh((
                ((((si.provider_trend_slope_7d)::numeric / si.price_anchor) / si.cov_anchor) * 6 * si.sample_confidence)::double precision
              )),
              0
            ),
            100
          )
        )::numeric, 1)
        else null
      end as signal_trend,
      case
        when si.selected_window is not null
         and si.sample_points >= 10
         and si.provider_trend_slope_7d is not null
        then round((
          least(
            greatest(
              100 * tanh((
                (
                  greatest((((si.provider_trend_slope_7d)::numeric / si.price_anchor) / si.cov_anchor), 0)
                  * (0.55 + 0.45 * si.activity_score)
                  * (0.5 + 0.5 * si.sample_confidence)
                  * (1 - si.range_position)
                  * 2.8
                )::double precision
              )),
              0
            ),
            100
          )
        )::numeric, 1)
        else null
      end as signal_breakout,
      case
        when si.selected_window is not null
         and si.sample_points >= 10
        then round((
          least(
            greatest(
              (
                power(1 - si.range_position, 1.15)
                * (0.35 + 0.65 * si.sample_confidence)
                * (0.25 + 0.75 * si.activity_score)
                * sqrt(least(si.price_anchor / 2.0, 1))
                * 100
              ),
              0
            ),
            100
          )
        )::numeric, 1)
        else null
      end as signal_value,
      case
        when si.selected_window is not null
         and si.sample_points >= 10 then now()
        else null
      end as signals_as_of_ts
    from signal_inputs si
  )
  update public.variant_metrics vm
  set
    history_points_30d = s.history_points_30d,
    signal_trend = s.signal_trend,
    signal_breakout = s.signal_breakout,
    signal_value = s.signal_value,
    signals_as_of_ts = s.signals_as_of_ts,
    updated_at = now()
  from scored s
  where vm.id = s.id;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok', true,
    'rowsUpdated', affected
  );
end;
$$;
