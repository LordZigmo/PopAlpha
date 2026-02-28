-- 20260301150000_refresh_derived_signals_variant_metrics.sql
--
-- Replaces refresh_derived_signals() so derived signals are written only to
-- variant_metrics, never to legacy card_metrics.

create or replace function public.refresh_derived_signals()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
  reset_count integer;
begin
  with history_counts as (
    select
      php.canonical_slug,
      php.variant_ref,
      count(*)::integer as points_30d
    from public.price_history_points php
    where php.ts >= (now() - interval '30 days')
    group by php.canonical_slug, php.variant_ref
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
  where vm.provider = 'JUSTTCG'
    and vm.canonical_slug = hc.canonical_slug
    and vm.variant_ref = hc.variant_ref;

  get diagnostics affected = row_count;

  update public.variant_metrics vm
  set
    history_points_30d = 0,
    signal_trend = null,
    signal_breakout = null,
    signal_value = null,
    signals_as_of_ts = null,
    updated_at = now()
  where vm.provider = 'JUSTTCG'
    and not exists (
      select 1
      from public.price_history_points php
      where php.canonical_slug = vm.canonical_slug
        and php.variant_ref = vm.variant_ref
        and php.ts >= (now() - interval '30 days')
    );

  get diagnostics reset_count = row_count;
  affected := affected + reset_count;

  return jsonb_build_object(
    'ok', true,
    'rowsUpdated', affected
  );
end;
$$;
