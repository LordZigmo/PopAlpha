create or replace function public.backfill_snapshot_history_points_for_sets(
  only_set_ids text[] default null,
  p_window_days integer default 90
)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  affected integer := 0;
  window_days integer := greatest(1, coalesce(p_window_days, 90));
begin
  insert into public.price_history_points (
    canonical_slug,
    variant_ref,
    provider,
    ts,
    price,
    currency,
    source_window
  )
  select
    ps.canonical_slug,
    case
      when ps.printing_id is not null then ps.printing_id::text || '::RAW'
      else ps.canonical_slug || '::RAW'
    end as variant_ref,
    ps.provider,
    ps.observed_at as ts,
    ps.price_value as price,
    ps.currency,
    'snapshot'::text as source_window
  from public.price_snapshots ps
  join public.canonical_cards cc
    on cc.slug = ps.canonical_slug
  left join public.card_printings cp
    on cp.id = ps.printing_id
  where upper(coalesce(ps.grade, 'RAW')) = 'RAW'
    and ps.observed_at >= now() - make_interval(days => window_days)
    and (
      only_set_ids is null
      or public.normalize_set_id(coalesce(cp.set_name, cc.set_name)) = any(only_set_ids)
    )
  on conflict (provider, variant_ref, ts, source_window) do nothing;

  get diagnostics affected = row_count;
  return affected;
end;
$$;
