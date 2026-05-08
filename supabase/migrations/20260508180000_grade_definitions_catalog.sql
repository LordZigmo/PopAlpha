-- 20260508180000_grade_definitions_catalog.sql
--
-- Originally timestamped 20260508120000 in PR #31; renamed to 20260508180000
-- in the 2026-05-08 drift cleanup after a 20260508120000 collision was
-- discovered: a Dashboard-applied `canonical_cards_native_names` migration
-- was already recorded at that version in prod, which caused
-- `supabase db push` to silently skip this catalog migration entirely.
-- The rename gives the catalog a fresh version that's not in remote
-- history yet, so push will actually apply it.
--
-- PR 1 of the grade-catalog promotion (see docs/schema-audit-2026-05-08.md §8 item 3).
--
-- Today the `grade` column is unconstrained TEXT on price_snapshots, price_history,
-- card_metrics, variant_metrics, holdings, and tracked_assets. Three naming
-- conventions are already in flight across the codebase:
--
--   1. Bucket form (used by the variant-ref normalizer in lib/identity/variant-ref.mjs
--      and the price tables): RAW | 7_OR_LESS | 8 | 9 | 9_5 | 10 | 10_PERFECT
--   2. G-prefix form (used by the front-end constant GRADE_BUCKETS in
--      lib/cards/detail-types.ts and by the eBay query builder):
--      LE_7 | G8 | G9 | G9_5 | G10 | G10_PERFECT
--   3. Legacy PSA-prefix (used by holdings input via app/portfolio/PortfolioClient.tsx
--      and the GradeSelection type in lib/ebay-query.ts): PSA9 | PSA10
--
-- Without a catalog, a new ingestion source arriving with a fourth convention
-- (e.g. 'PSA Gem Mint 10' from a partner feed) would silently fail to display
-- alongside existing rows. Promoting `grade` to a catalog FK forces ingestion
-- to map at the boundary, where mismatches become hard errors instead of
-- silent display gaps.
--
-- This migration ships the FOUNDATION ONLY: the catalog and alias tables, with
-- a seed that captures the existing taxonomy. No FK additions, no data backfill,
-- no app code changes. Follow-up PRs handle the FK promotion in expand-contract
-- form (add nullable grade_id columns, backfill, dual-write, migrate readers,
-- drop the TEXT column).
--
-- Sequencing constraint surfaced during review: variant_metrics has a CHECK
-- constraint at 20260416000000_downsample_price_history.sql:178–193 that
-- enumerates the 13 allowed grade strings. Canonical codes seeded here are a
-- subset of that constraint's allowed list, so PR 2's variant_metrics backfill
-- can write canonical-form strings without amending the CHECK.

create table if not exists public.grade_definitions (
  grade_id     smallint primary key,
  code         text not null,
  grader       text null,
  tier         numeric(3,1) null,
  is_pristine  boolean not null default false,
  display_name text not null,
  sort_order   smallint not null,
  notes        text null,
  created_at   timestamptz not null default now(),
  constraint grade_definitions_grader_check
    check (grader is null or grader in ('PSA','BGS','CGC','TAG')),
  constraint grade_definitions_tier_check
    check (tier is null or (tier >= 1 and tier <= 10)),
  constraint grade_definitions_raw_consistency
    check (
      (tier is null and grader is null and is_pristine = false)
      or tier is not null
    )
);

create unique index if not exists grade_definitions_code_uidx
  on public.grade_definitions (code);

create index if not exists grade_definitions_sort_order_idx
  on public.grade_definitions (sort_order, code);

create index if not exists grade_definitions_grader_tier_idx
  on public.grade_definitions (grader, tier);

alter table public.grade_definitions enable row level security;
revoke all on table public.grade_definitions from anon, authenticated;
grant select on table public.grade_definitions to anon, authenticated;

drop policy if exists grade_definitions_public_read on public.grade_definitions;
create policy grade_definitions_public_read
  on public.grade_definitions
  for select
  to anon, authenticated
  using (true);

-- ── grade_aliases ────────────────────────────────────────────────────────────
-- Maps legacy / alternative grade codes to the canonical grade_id. Lets PR 2's
-- backfill resolve `holdings.grade='PSA10'` (no underscore) → grade_id=9
-- (canonical 'PSA10') without polluting the main catalog with duplicate rows.
-- Also maps the G-prefix UI taxonomy (LE_7 / G8 / G9 / G9_5 / G10 / G10_PERFECT)
-- to the bucket-form canonical codes used in the price tables.

create table if not exists public.grade_aliases (
  alias      text primary key,
  grade_id   smallint not null references public.grade_definitions(grade_id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists grade_aliases_grade_id_idx
  on public.grade_aliases (grade_id);

alter table public.grade_aliases enable row level security;
revoke all on table public.grade_aliases from anon, authenticated;
grant select on table public.grade_aliases to anon, authenticated;

drop policy if exists grade_aliases_public_read on public.grade_aliases;
create policy grade_aliases_public_read
  on public.grade_aliases
  for select
  to anon, authenticated
  using (true);

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- Catalog rows. IDs are stable contract values — do not renumber.
-- 1–7  reserved for grader-agnostic bucket grades (the form used in price tables).
-- 8–9  reserved for PSA-specific legacy codes used by holdings.
-- 10+  available for future grader-specific entries (BGS_9_5, CGC_10, etc.) as
--      ingestion paths land that need them.
--
-- Canonical codes match the strings already produced by existing writers so
-- PR 2's backfill is a direct `code = grade` join, not a translation step.

insert into public.grade_definitions
  (grade_id, code,         grader, tier, is_pristine, display_name,    sort_order, notes)
values
  (1,        'RAW',         null,  null, false,       'Raw',            0,
   'Ungraded card. Default value across all price tables.'),
  (2,        '7_OR_LESS',   null,  7,    false,       '7 or Less',      10,
   'Grader-agnostic bucket: any grader, tier 7 or below. Bucket form stored by variant-ref normalizer.'),
  (3,        '8',           null,  8,    false,       '8',              20,
   'Grader-agnostic bucket: any grader, tier 8.'),
  (4,        '9',           null,  9,    false,       '9',              30,
   'Grader-agnostic bucket: any grader, tier 9.'),
  (5,        '9_5',         null,  9.5,  false,       '9.5',            40,
   'Grader-agnostic bucket: any grader, tier 9.5 (BGS half-grade).'),
  (6,        '10',          null,  10,   false,       '10',             50,
   'Grader-agnostic bucket: any grader, tier 10 standard.'),
  (7,        '10_PERFECT',  null,  10,   true,        '10 (Perfect)',   60,
   'Grader-agnostic bucket: perfect-10 sub-grade (PSA Pristine 10, BGS Black Label, CGC Perfect 10, TAG Gem Mint 10). Canonical code matches the string in lib/identity/variant-ref.mjs and the variant_metrics CHECK constraint.'),
  (8,        'PSA9',        'PSA', 9,    false,       'PSA 9',          31,
   'PSA-specific tier 9. Used by holdings UI; grader is explicit on this row rather than inferred from variant_ref. Canonical code matches the no-underscore form used by app/portfolio/PortfolioClient.tsx and lib/ebay-query.ts.'),
  (9,        'PSA10',       'PSA', 10,   false,       'PSA 10',         51,
   'PSA-specific tier 10. Used by holdings UI; grader is explicit on this row rather than inferred from variant_ref. Canonical code matches the no-underscore form used by app/portfolio/PortfolioClient.tsx and lib/ebay-query.ts.')
on conflict (grade_id) do nothing;

-- Alias map. Maps legacy / alternative codes to the canonical grade_id above.
-- Maintained as the source of truth for "what does this string mean" lookups
-- during PR 2 backfill and any future ingestion path that receives a non-canonical
-- string.

insert into public.grade_aliases (alias, grade_id) values
  ('LE_7',        2),  -- G-prefix form from lib/cards/detail-types.ts GRADE_BUCKETS
  ('G8',          3),
  ('G9',          4),
  ('G9_5',        5),
  ('G10',         6),
  ('G10_PERFECT', 7)
on conflict (alias) do nothing;

comment on table public.grade_definitions is
  'Catalog of grade codes used by price/holdings/variant_metrics tables. PR 1 of the grade-FK promotion (see docs/schema-audit-2026-05-08.md). Rows are referenced by future grade_id FKs on the bare TEXT grade columns.';

comment on table public.grade_aliases is
  'Legacy/alternative grade codes that map to grade_definitions.grade_id. Used by PR 2 backfill and ingestion-time lookups when a non-canonical string is encountered.';
