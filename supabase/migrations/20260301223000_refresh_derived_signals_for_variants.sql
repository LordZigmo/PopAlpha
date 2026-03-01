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
  history_counts as (
    select
      tk.canonical_slug,
      tk.variant_ref,
      tk.provider,
      tk.grade,
      count(php.*)::integer as points_30d
    from target_keys tk
    left join public.price_history_points php
      on php.canonical_slug = tk.canonical_slug
     and php.variant_ref = tk.variant_ref
     and php.provider = tk.provider
     and php.ts >= (now() - interval '30 days')
    where tk.canonical_slug is not null
      and tk.variant_ref is not null
      and tk.provider is not null
      and tk.grade is not null
    group by tk.canonical_slug, tk.variant_ref, tk.provider, tk.grade
  )
  update public.variant_metrics vm
  set
    history_points_30d = coalesce(hc.points_30d, 0),
    signal_trend = case
      when coalesce(hc.points_30d, 0) >= 10
       and vm.provider_trend_slope_7d is not null
       and vm.provider_cov_price_30d is not null
       and vm.provider_cov_price_30d <> 0
      then round((vm.provider_trend_slope_7d / nullif(vm.provider_cov_price_30d, 0))::numeric, 4)
      else null
    end,
    signal_breakout = case
      when coalesce(hc.points_30d, 0) >= 10
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
      when coalesce(hc.points_30d, 0) >= 10
       and vm.provider_price_relative_to_30d_range is not null
      then round(((1 - vm.provider_price_relative_to_30d_range) * 100)::numeric, 2)
      else null
    end,
    signals_as_of_ts = case
      when coalesce(hc.points_30d, 0) >= 10 then now()
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

