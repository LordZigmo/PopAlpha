-- 20260301200000_variant_ref_identity_standardization.sql
--
-- Standardize printing-backed variant_ref values so raw and graded rows share
-- one deterministic identity:
--   RAW    -> <printing_id>::RAW
--   GRADED -> <printing_id>::<PROVIDER>::<GRADE_BUCKET>
--
-- Sealed rows are intentionally excluded because they do not yet have
-- a printing_id-based identity axis.

create unique index if not exists variant_metrics_slug_printing_provider_grade_uidx
  on public.variant_metrics (canonical_slug, printing_id, provider, grade)
  where printing_id is not null;

do $$
declare
  mapped_rows integer := 0;
  duplicate_history_rows_deleted integer := 0;
  duplicate_target_rows_deleted integer := 0;
  history_rows_updated integer := 0;
  metric_rows_updated integer := 0;
begin
  drop table if exists _variant_ref_backfill_map;

  create temporary table _variant_ref_backfill_map on commit drop as
  select distinct
    vm.canonical_slug,
    vm.provider,
    vm.grade,
    vm.variant_ref as old_variant_ref,
    case
      when upper(coalesce(vm.grade, 'RAW')) = 'RAW'
        then vm.printing_id::text || '::RAW'
      when upper(coalesce(vm.provider, '')) in ('PSA', 'CGC', 'BGS', 'TAG')
       and upper(coalesce(vm.grade, '')) in ('LE_7', 'G8', 'G9', 'G10', '7_OR_LESS', '8', '9', '10')
        then vm.printing_id::text || '::' || upper(vm.provider) || '::' ||
          case upper(vm.grade)
            when 'LE_7' then '7_OR_LESS'
            when 'G8' then '8'
            when 'G9' then '9'
            when 'G10' then '10'
            else upper(vm.grade)
          end
      else vm.variant_ref
    end as new_variant_ref
  from public.variant_metrics vm
  where vm.printing_id is not null;

  delete from _variant_ref_backfill_map
  where old_variant_ref is not distinct from new_variant_ref;

  select count(*) into mapped_rows
  from _variant_ref_backfill_map;

  with ranked as (
    select
      php.ctid as target_ctid,
      row_number() over (
        partition by php.canonical_slug, map.new_variant_ref, php.provider, php.ts
        order by php.ctid
      ) as rn
    from public.price_history_points php
    join _variant_ref_backfill_map map
      on map.canonical_slug = php.canonical_slug
     and map.provider = php.provider
     and map.old_variant_ref = php.variant_ref
  )
  delete from public.price_history_points php
  using ranked
  where php.ctid = ranked.target_ctid
    and ranked.rn > 1;

  get diagnostics duplicate_history_rows_deleted = row_count;

  delete from public.price_history_points php
  using _variant_ref_backfill_map map
  where map.canonical_slug = php.canonical_slug
    and map.provider = php.provider
    and map.old_variant_ref = php.variant_ref
    and exists (
      select 1
      from public.price_history_points existing
      where existing.canonical_slug = php.canonical_slug
        and existing.provider = php.provider
        and existing.ts = php.ts
        and existing.variant_ref = map.new_variant_ref
        and existing.ctid <> php.ctid
    );

  get diagnostics duplicate_target_rows_deleted = row_count;

  update public.price_history_points php
  set variant_ref = map.new_variant_ref
  from _variant_ref_backfill_map map
  where map.canonical_slug = php.canonical_slug
    and map.provider = php.provider
    and map.old_variant_ref = php.variant_ref;

  get diagnostics history_rows_updated = row_count;

  update public.variant_metrics vm
  set
    variant_ref = map.new_variant_ref,
    updated_at = now()
  from _variant_ref_backfill_map map
  where map.canonical_slug = vm.canonical_slug
    and map.provider = vm.provider
    and map.grade = vm.grade
    and map.old_variant_ref = vm.variant_ref;

  get diagnostics metric_rows_updated = row_count;

  raise notice 'variant_ref standardization: mapped %, price_history_points updated %, duplicate history rows deleted %, duplicate target rows deleted %, variant_metrics updated %',
    mapped_rows,
    history_rows_updated,
    duplicate_history_rows_deleted,
    duplicate_target_rows_deleted,
    metric_rows_updated;
end
$$;

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
      and upper(coalesce(grade, '')) in ('LE_7', 'G8', 'G9', 'G10', '7_OR_LESS', '8', '9', '10')
      and variant_ref = printing_id::text || '::' || upper(provider) || '::' ||
        case upper(grade)
          when 'LE_7' then '7_OR_LESS'
          when 'G8' then '8'
          when 'G9' then '9'
          when 'G10' then '10'
          else upper(grade)
        end
    )
  ) not valid;

alter table public.variant_metrics
  validate constraint variant_metrics_printing_key_variant_ref_chk;
