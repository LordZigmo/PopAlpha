-- Drop the superseded partial unique index on price_history_points once the
-- non-partial replacement exists, then tighten autovacuum/analyze settings so
-- the planner stays current on the high-churn history table.

do $$
begin
  if to_regclass('public.price_history_points_provider_variant_ref_ts_window_uidx') is null then
    raise exception
      'Missing replacement index public.price_history_points_provider_variant_ref_ts_window_uidx; refusing to drop public.price_history_points_provider_variant_ts_window_uidx';
  end if;

  if to_regclass('public.price_history_points_provider_variant_ts_window_uidx') is not null then
    execute 'drop index public.price_history_points_provider_variant_ts_window_uidx';
  end if;
end;
$$;

alter table public.price_history_points set (
  autovacuum_enabled = true,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 50000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 50000,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_analyze_threshold = 25000
);

analyze public.price_history_points;
