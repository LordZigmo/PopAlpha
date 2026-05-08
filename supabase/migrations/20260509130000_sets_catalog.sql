-- 20260509130000_sets_catalog.sql
--
-- PR 1 of the sets-table promotion (see docs/schema-audit-2026-05-08.md §8 item 1).
--
-- Today `set_id` is not a column anywhere in the schema — it's a derived
-- string computed via public.normalize_set_id(set_name) at every read site
-- (the canonical_set_catalog view, the 6 set-summary refresh functions, the
-- public_card_metrics consumer code paths). The pattern works but blocks
-- five things the audit called out:
--
--   1. Curated set metadata. There's no row to attach a release_date,
--      era ('Sword & Shield', 'Scarlet & Violet'), or parent_set_id
--      (linking sub-sets like "Brilliant Stars" to "Sword & Shield") to.
--   2. Language-aware set indices. Today the JP catalog (212 distinct
--      sets) and the EN catalog (195 sets) are intermixed in
--      canonical_set_catalog with no first-class language axis.
--   3. Total-card-count truth source. canonical_set_catalog gives a
--      derived count from card_printings GROUP BY; we want a curated
--      "official set size" column that doesn't drift when scrapers add
--      late printings.
--   4. FK integrity for cache tables. variant_price_latest,
--      set_summary_snapshots, set_finish_summary_latest etc. all carry
--      `set_id text` columns that could be FK-bound to a real sets PK.
--   5. Higher groupings. No `era` or `block` axis exists for queries like
--      "show me Crown Zenith's market cap by era" or "filter to S&V era".
--
-- This migration ships the FOUNDATION ONLY: the sets table + initial seed
-- derived from card_printings. No FK additions on card_printings yet, no
-- refresh mechanism, no cache-table FKs. Follow-up PRs add:
--
--   PR 2: AFTER INSERT/UPDATE trigger on card_printings + RPC to keep
--         sets in sync as new printings/sets land.
--   PR 3: Nullable `set_id smallint` (or text) FK column on
--         card_printings, backfill, BEFORE INSERT/UPDATE OF set_name
--         trigger.
--   PR 4: Curate the era / release_date / parent_set_id columns from a
--         data source — not derivable from card_printings.
--   PR 5: Add FKs from cache tables (variant_price_latest, etc.) so
--         set_id integrity is enforced everywhere.
--
-- This PR is purely additive — readers continue using
-- normalize_set_id(set_name) and the canonical_set_catalog view, both
-- unchanged. The new sets table is queryable but not yet referenced by
-- anything else in the schema.

create table if not exists public.sets (
  set_id              text        primary key,
  set_name            text        not null,
  language            text        null,
  year                int         null,
  release_date        date        null,
  era                 text        null,
  parent_set_id       text        null
                                  references public.sets(set_id) on delete set null,
  -- Two distinct card-count axes — see column comments for the split.
  derived_card_count  int         not null default 0,
  official_card_count int         null,
  source              text        not null default 'card_printings_seed',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists sets_set_name_idx
  on public.sets (set_name);

create index if not exists sets_language_idx
  on public.sets (language) where language is not null;

create index if not exists sets_era_idx
  on public.sets (era) where era is not null;

create index if not exists sets_release_date_idx
  on public.sets (release_date) where release_date is not null;

create index if not exists sets_parent_set_id_idx
  on public.sets (parent_set_id) where parent_set_id is not null;

alter table public.sets enable row level security;
revoke all on table public.sets from anon, authenticated;
grant select on table public.sets to anon, authenticated;

drop policy if exists sets_public_read on public.sets;
create policy sets_public_read
  on public.sets
  for select
  to anon, authenticated
  using (true);

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- Derive one row per distinct set_id from card_printings. set_id is the slug
-- form produced by public.normalize_set_id(set_name).
--
-- Aggregation rules:
--   set_name             — min(set_name) per set_id. Verified at seed time:
--                           every distinct set_id today has exactly ONE
--                           set_name across all printings, so min() and any
--                           other picker produce the same result. PR 4 may
--                           overwrite from a curated source.
--   language             — most-common language across the set's printings.
--                           For mixed-language sets (rare, mostly typos), the
--                           majority wins.
--   year                 — min(year) per set_id. Earliest known year.
--   derived_card_count   — count(*) of printings in the set. Refreshed by
--                           future PR 2 trigger / RPC.
--   official_card_count  — NULL (curated metadata, future PR).
--   release_date, era,
--   parent_set_id        — NULL (curated metadata, future PR).
--
-- on conflict do nothing keeps the seed re-runnable.

with by_set_lang as (
  select
    public.normalize_set_id(cp.set_name) as set_id,
    cp.language,
    count(*) as n
  from public.card_printings cp
  where cp.set_name is not null
    and cp.language is not null
  group by public.normalize_set_id(cp.set_name), cp.language
),
top_lang as (
  select distinct on (set_id)
    set_id,
    language
  from by_set_lang
  order by set_id, n desc, language
),
by_set as (
  select
    public.normalize_set_id(cp.set_name) as set_id,
    min(cp.set_name) as set_name,
    min(cp.year) as year,
    count(*) as total_card_count
  from public.card_printings cp
  where cp.set_name is not null
  group by public.normalize_set_id(cp.set_name)
)
insert into public.sets (set_id, set_name, language, year, derived_card_count, source)
select
  bs.set_id,
  bs.set_name,
  tl.language,
  bs.year,
  bs.total_card_count,
  'card_printings_seed'
from by_set bs
left join top_lang tl on tl.set_id = bs.set_id
where bs.set_id is not null
on conflict (set_id) do nothing;

-- ── Comments ─────────────────────────────────────────────────────────────────

comment on table public.sets is
  'Canonical sets catalog. PR 1 of the sets-table promotion (see docs/schema-audit-2026-05-08.md §8 item 1). Seeded from card_printings via normalize_set_id(set_name). Curated columns (era, release_date, parent_set_id) are NULL until PR 4 backfills them from a data source. card_printings.set_id FK and per-printing trigger ship in PR 3.';

comment on column public.sets.set_id is
  'Canonical set slug. Computed by public.normalize_set_id(set_name) — currently lower-kebab-case of set_name. Stable across renames as long as the set_name normalizes to the same slug. Same value used by the existing canonical_set_catalog view and the set-summary cache tables.';

comment on column public.sets.set_name is
  'Representative set name. Seed picks min(set_name) per set_id; verified at seed time that every distinct set_id maps to exactly one set_name across all printings, so min() and any other picker are equivalent today. Not guaranteed to be the marketing/canonical name — PR 4 may overwrite from a curated source (Bulbapedia / Scrydex set metadata).';

comment on column public.sets.language is
  'Most-common language across the set''s printings (EN | JP | unknown). Derived from card_printings.language at seed time, NULL if the set has only language-NULL printings. Distinct from a per-printing language axis — a set can technically have mixed-language printings (typos, alt-region releases) but this column reflects the dominant language.';

comment on column public.sets.year is
  'Min year across printings in the set. Distinct from release_date (curated). Useful when release_date is NULL but a rough chronological signal is needed.';

comment on column public.sets.release_date is
  'Curated set release date. NULL until PR 4 ingests from a data source (Bulbapedia, Scrydex set metadata, etc.). Use year as the fallback chronological signal.';

comment on column public.sets.era is
  'Curated era / block label (e.g. ''Scarlet & Violet'', ''Sword & Shield'', ''Sun & Moon''). NULL until PR 4. Use parent_set_id for sub-set hierarchy; era is for top-level grouping.';

comment on column public.sets.parent_set_id is
  'For sub-sets (e.g. ''Crown Zenith'' → parent ''Sword & Shield''), points to the parent set''s set_id. NULL for top-level sets. Self-referential FK with ON DELETE SET NULL — orphaning a sub-set if its parent disappears is preferable to cascading the delete.';

comment on column public.sets.derived_card_count is
  'Count of printings currently in card_printings for this set. Source-of-truth is card_printings; this column is a denormalized cache refreshed by future PR 2 trigger / RPC. Will tick up as ingestion adds late printings.';

comment on column public.sets.official_card_count is
  'Curated official set size as published by the source ("Set has 244 cards including secret rares"). Distinct from derived_card_count which counts what we''ve actually ingested. NULL until PR 4 ingests from a curated source. Useful for "x out of y" coverage progress and for detecting when ingestion is incomplete (derived < official).';

comment on column public.sets.source is
  'Origin marker for the row. Single-token convention matching card_printings.source: ''card_printings_seed'' (this PR), ''refresh_rpc'' (future PR 2), ''bulbapedia'' / ''scrydex_set_metadata'' / ''curated'' (future PR 4 ingest paths).';
