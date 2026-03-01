-- The backfill routes use PostgREST upserts with explicit ON CONFLICT column
-- lists. Partial unique indexes are not sufficient for that path because the
-- generated INSERT ... ON CONFLICT (...) cannot infer a partial index.
--
-- These non-partial unique indexes make the live upsert targets valid while
-- still allowing nullable columns to remain nullable (NULL values do not
-- collide under Postgres unique indexes).

with duplicate_rows as (
  select
    ctid,
    row_number() over (
      partition by provider, variant_ref, ts, source_window
      order by ts asc
    ) as rn
  from public.price_history_points
)
delete from public.price_history_points php
using duplicate_rows d
where php.ctid = d.ctid
  and d.rn > 1;

create unique index if not exists card_external_mappings_source_mapping_type_printing_id_uidx
  on public.card_external_mappings (source, mapping_type, printing_id);

create unique index if not exists variant_metrics_canonical_slug_printing_provider_grade_uidx
  on public.variant_metrics (canonical_slug, printing_id, provider, grade);

create unique index if not exists price_history_points_provider_variant_ref_ts_window_uidx
  on public.price_history_points (provider, variant_ref, ts, source_window);
