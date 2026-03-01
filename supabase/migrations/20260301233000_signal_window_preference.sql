create or replace function public.preferred_signal_history_window(p_provider text, p_variant_ref text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1
      from public.price_history_points php
      where php.provider = p_provider
        and php.variant_ref = p_variant_ref
        and php.source_window = 'full'
    ) then 'full'
    when exists (
      select 1
      from public.price_history_points php
      where php.provider = p_provider
        and php.variant_ref = p_variant_ref
        and php.source_window = '365d'
    ) then '365d'
    when exists (
      select 1
      from public.price_history_points php
      where php.provider = p_provider
        and php.variant_ref = p_variant_ref
        and php.source_window = '30d'
    ) then '30d'
    else null
  end
$$;

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
      vm.canonical_slug,
      vm.variant_ref,
      vm.provider,
      public.preferred_signal_history_window(vm.provider, vm.variant_ref) as selected_window
    from public.variant_metrics vm
    where vm.provider = 'JUSTTCG'
  ),
  history_counts as (
    select
      pw.canonical_slug,
      pw.variant_ref,
      pw.provider,
      pw.selected_window,
      count(php.*)::integer as sample_points
    from preferred_windows pw
    left join public.price_history_points php
      on php.canonical_slug = pw.canonical_slug
     and php.variant_ref = pw.variant_ref
     and php.provider = pw.provider
     and php.source_window = pw.selected_window
    group by pw.canonical_slug, pw.variant_ref, pw.provider, pw.selected_window
  )
  update public.variant_metrics vm
  set
    history_points_30d = case
      when hc.selected_window is null then 0
      else coalesce(hc.sample_points, 0)
    end,
    signal_trend = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10
       and vm.provider_trend_slope_7d is not null
       and vm.provider_cov_price_30d is not null
       and vm.provider_cov_price_30d <> 0
      then round((vm.provider_trend_slope_7d / nullif(vm.provider_cov_price_30d, 0))::numeric, 4)
      else null
    end,
    signal_breakout = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10
       and vm.provider_trend_slope_7d is not null
       and vm.provider_price_relative_to_30d_range is not null
      then round((
        vm.provider_trend_slope_7d
        * ln(1 + greatest(coalesce(vm.provider_price_changes_count_30d, 0), 0)::numeric)
        * (1 - vm.provider_price_relative_to_30d_range)
      )::numeric, 4)
      else null
    end,
    signal_value = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10
       and vm.provider_price_relative_to_30d_range is not null
      then round(((1 - vm.provider_price_relative_to_30d_range) * 100)::numeric, 2)
      else null
    end,
    signals_as_of_ts = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10 then now()
      else null
    end,
    updated_at = now()
  from history_counts hc
  where vm.provider = hc.provider
    and vm.canonical_slug = hc.canonical_slug
    and vm.variant_ref = hc.variant_ref;

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
      tk.canonical_slug,
      tk.variant_ref,
      tk.provider,
      tk.grade,
      public.preferred_signal_history_window(tk.provider, tk.variant_ref) as selected_window
    from target_keys tk
    where tk.canonical_slug is not null
      and tk.variant_ref is not null
      and tk.provider is not null
      and tk.grade is not null
  ),
  history_counts as (
    select
      pw.canonical_slug,
      pw.variant_ref,
      pw.provider,
      pw.grade,
      pw.selected_window,
      count(php.*)::integer as sample_points
    from preferred_windows pw
    left join public.price_history_points php
      on php.canonical_slug = pw.canonical_slug
     and php.variant_ref = pw.variant_ref
     and php.provider = pw.provider
     and php.source_window = pw.selected_window
    group by pw.canonical_slug, pw.variant_ref, pw.provider, pw.grade, pw.selected_window
  )
  update public.variant_metrics vm
  set
    history_points_30d = case
      when hc.selected_window is null then 0
      else coalesce(hc.sample_points, 0)
    end,
    signal_trend = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10
       and vm.provider_trend_slope_7d is not null
       and vm.provider_cov_price_30d is not null
       and vm.provider_cov_price_30d <> 0
      then round((vm.provider_trend_slope_7d / nullif(vm.provider_cov_price_30d, 0))::numeric, 4)
      else null
    end,
    signal_breakout = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10
       and vm.provider_trend_slope_7d is not null
       and vm.provider_price_relative_to_30d_range is not null
      then round((
        vm.provider_trend_slope_7d
        * ln(1 + greatest(coalesce(vm.provider_price_changes_count_30d, 0), 0)::numeric)
        * (1 - vm.provider_price_relative_to_30d_range)
      )::numeric, 4)
      else null
    end,
    signal_value = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10
       and vm.provider_price_relative_to_30d_range is not null
      then round(((1 - vm.provider_price_relative_to_30d_range) * 100)::numeric, 2)
      else null
    end,
    signals_as_of_ts = case
      when hc.selected_window is not null
       and coalesce(hc.sample_points, 0) >= 10 then now()
      else null
    end,
    updated_at = now()
  from history_counts hc
  where vm.canonical_slug = hc.canonical_slug
    and vm.variant_ref = hc.variant_ref
    and vm.provider = hc.provider
    and vm.grade = hc.grade;

  get diagnostics affected = row_count;

  return jsonb_build_object(
    'ok', true,
    'rowsUpdated', affected
  );
end;
$$;
