-- 20260416000000_downsample_price_history.sql
--
-- Fix CPU saturation caused by 13M-row price_history_points table.
--
--   1. Batch downsample function (keeps 1 point/card/day for old data)
--   2. Update prune_old_data() to include ongoing downsample
--   3. Drop unused indexes (77 MB)
--   4. Fix variant_metrics constraint to allow G9_5/G10_PERFECT

-- ── 1. Batch downsample function ────────────────────────────────────────────
--
-- Processes a 1-day slab: keeps the LAST observation per
-- (canonical_slug, variant_ref, provider, source_window, day),
-- deletes the intra-day duplicates. Caller iterates day-by-day.

create or replace function public.downsample_price_history_points_batch(
  p_batch_size  int         default 10000,
  p_older_than  timestamptz default now() - interval '30 days',
  p_newer_than  timestamptz default now() - interval '31 days'
)
returns jsonb
language plpgsql
security definer
set statement_timeout = '120s'
set search_path = public
as $$
declare
  _deleted int;
begin
  with ranked as (
    select id,
           row_number() over (
             partition by canonical_slug, variant_ref, provider, source_window,
                          (ts at time zone 'UTC')::date
             order by ts desc
           ) as rn
    from public.price_history_points
    where ts >= p_newer_than
      and ts < p_older_than
  ),
  to_delete as (
    select id from ranked where rn > 1
    limit p_batch_size
  )
  delete from public.price_history_points
  where id in (select id from to_delete);

  get diagnostics _deleted = row_count;
  return jsonb_build_object('deleted', _deleted);
end;
$$;

revoke all on function public.downsample_price_history_points_batch(int, timestamptz, timestamptz)
  from public, anon, authenticated;

-- ── 2. Update prune_old_data() with downsample step ────────────────────────

create or replace function public.prune_old_data()
returns jsonb
language plpgsql
security definer
set statement_timeout = '120s'
as $$
declare
  _chunk_limit  int := 5000;
  _deleted      int;
  _ds_deleted   int;
  _result       jsonb := '{}'::jsonb;
begin
  -- 1. provider_raw_payloads — 14-day retention
  delete from public.provider_raw_payloads
  where  id in (
    select id from public.provider_raw_payloads
    where  fetched_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_raw_payloads', _deleted);

  -- 2. provider_ingests — 30-day retention
  delete from public.provider_ingests
  where  id in (
    select id from public.provider_ingests
    where  created_at < now() - interval '30 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_ingests', _deleted);

  -- 3. provider_normalized_observations — 14-day retention
  delete from public.provider_normalized_observations
  where  id in (
    select id from public.provider_normalized_observations
    where  observed_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_normalized_observations', _deleted);

  -- 4. listing_observations — 14-day retention
  delete from public.listing_observations
  where  id in (
    select id from public.listing_observations
    where  observed_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('listing_observations', _deleted);

  -- 5. card_page_views — 90-day retention
  delete from public.card_page_views
  where  id in (
    select id from public.card_page_views
    where  viewed_at < now() - interval '90 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('card_page_views', _deleted);

  -- 6. price_snapshots — 45-day retention
  delete from public.price_snapshots
  where  id in (
    select id from public.price_snapshots
    where  observed_at < now() - interval '45 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('price_snapshots', _deleted);

  -- 7a. price_history_points — 90-day hard delete
  delete from public.price_history_points
  where  id in (
    select id from public.price_history_points
    where  ts < now() - interval '90 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('price_history_points', _deleted);

  -- 7b. price_history_points — downsample 30-31d window
  --     As data crosses the 30-day threshold, keep only 1 point per
  --     (card, variant, provider, source_window) per day.
  _ds_deleted := coalesce(
    (public.downsample_price_history_points_batch(
      _chunk_limit,
      now() - interval '30 days',
      now() - interval '31 days'
    )->>'deleted')::int,
    0
  );
  _result := _result || jsonb_build_object('price_history_points_downsampled', _ds_deleted);

  return _result;
end;
$$;

revoke all on function public.prune_old_data() from public, anon, authenticated;

-- ── 3. Drop unused indexes ──────────────────────────────────────────────────

drop index if exists public.price_history_points_snapshot_day_slug_idx;   -- 61 MB, 0 scans
drop index if exists public.price_history_points_dedup_idx;               -- 16 MB, 0 scans

-- ── 4. Fix variant_metrics constraint ───────────────────────────────────────

alter table public.variant_metrics
  drop constraint if exists variant_metrics_printing_key_variant_ref_chk;

alter table public.variant_metrics
  add constraint variant_metrics_printing_key_variant_ref_chk
  check (
    printing_id is null
    or (
      upper(coalesce(grade, 'RAW')) = 'RAW'
      and variant_ref = printing_id::text || '::RAW'
    )
    or (
      upper(coalesce(provider, '')) in ('PSA', 'CGC', 'BGS', 'TAG')
      and upper(coalesce(grade, '')) in (
        'LE_7', 'G8', 'G9', 'G9_5', 'G10', 'G10_PERFECT',
        '7_OR_LESS', '8', '9', '9_5', '10', '10_PERFECT'
      )
      and variant_ref = printing_id::text || '::' || upper(provider) || '::' ||
        case upper(grade)
          when 'LE_7' then '7_OR_LESS'
          when 'G8' then '8'
          when 'G9' then '9'
          when 'G9_5' then '9_5'
          when 'G10' then '10'
          when 'G10_PERFECT' then '10_PERFECT'
          else upper(grade)
        end
    )
  ) not valid;

alter table public.variant_metrics
  validate constraint variant_metrics_printing_key_variant_ref_chk;
