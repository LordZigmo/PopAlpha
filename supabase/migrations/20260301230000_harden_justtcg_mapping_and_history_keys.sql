-- Harden printing-backed JustTCG mapping uniqueness and allow canonical
-- price history refs to store multiple source windows (e.g. full + 30d)
-- without colliding with legacy free-text variant_ref cohorts.

-- 1) Deduplicate printing-backed mapping rows before adding the new unique index.
with ranked as (
  select
    id,
    row_number() over (
      partition by source, mapping_type, printing_id
      order by created_at desc nulls last, id desc
    ) as rn
  from public.card_external_mappings
  where mapping_type = 'printing'
    and printing_id is not null
)
delete from public.card_external_mappings cem
using ranked r
where cem.id = r.id
  and r.rn > 1;

create unique index if not exists card_external_mappings_printing_uidx
  on public.card_external_mappings (source, mapping_type, printing_id)
  where mapping_type = 'printing'
    and printing_id is not null;

create unique index if not exists card_external_mappings_canonical_uidx
  on public.card_external_mappings (source, mapping_type, canonical_slug)
  where mapping_type = 'canonical'
    and canonical_slug is not null;

-- 2) Split price_history_points dedupe between canonical variant refs and
-- legacy free-text refs so canonical refs can store full + 30d side by side.
drop index if exists public.price_history_points_dedup_idx;

create unique index if not exists price_history_points_dedup_idx
  on public.price_history_points (canonical_slug, variant_ref, provider, ts)
  where variant_ref not like '%::%';

create unique index if not exists price_history_points_provider_variant_ts_window_uidx
  on public.price_history_points (provider, variant_ref, ts, source_window)
  where variant_ref like '%::%';
