-- canonical_cards.is_digital: column + trigger + backfill
--
-- Goal: hide Pokémon TCG Pocket (digital-only) cards from every
-- user-facing surface (scanner identify, search, set browser,
-- homepage feeds, related-card carousels, etc.). Today, filtering is
-- done post-query in TypeScript via `isPhysicalPokemonSet()` from
-- `lib/sets/physical.ts`. That works but (a) wastes work fetching
-- digital rows we throw away, (b) is easy to forget at new call sites,
-- and (c) doesn't help iOS, which queries Supabase directly.
--
-- This migration adds a queryable boolean. The set list lives in two
-- places (here and `lib/sets/physical.ts`); both must stay aligned.
-- Source-of-truth split:
--   - Ingest-time decisions and code-grep anchors → lib/sets/physical.ts
--   - Query-time filters in SQL/PostgREST/iOS                      → this column
--
-- Naming note: this is `is_digital`, NOT `is_digital_only` (the latter
-- is what `card_image_embeddings` uses in Neon). They mean the same
-- thing — kept distinct because `is_digital` reads better in WHERE
-- clauses and the two stores are otherwise unrelated. Don't try to
-- "consistency-fix" them.
--
-- Idempotent: column add, function/trigger replace, backfill is a
-- targeted UPDATE that's safe to re-run.

alter table public.canonical_cards
  add column if not exists is_digital boolean not null default false;

comment on column public.canonical_cards.is_digital is
  'Derived from set_name via canonical_cards_set_is_digital trigger. '
  'Do not write directly — the trigger will overwrite. '
  'True for Pokémon TCG Pocket (digital-only) sets.';

-- Pure function: maps a set_name to is_digital. Mirrors the list in
-- lib/sets/physical.ts. canonical_cards has no `set_code` column today,
-- so the TS-side `tcgp-` set-code prefix branch is intentionally
-- omitted here. If a future Pocket set lands without matching this
-- list, it will leak through this filter — keep both lists aligned.
--
-- IF YOU ADD OR REMOVE A SET HERE: ship the same edit in
-- lib/sets/physical.ts AND include a re-backfill UPDATE in your
-- migration:
--   update public.canonical_cards
--      set is_digital = public.canonical_set_is_digital(set_name)
--    where is_digital is distinct from public.canonical_set_is_digital(set_name);
-- Without that, existing rows keep their old value (the trigger only
-- fires on insert / set_name change, not function-body change).
create or replace function public.canonical_set_is_digital(
  p_set_name text
) returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when p_set_name is null then false
    else lower(trim(p_set_name)) in (
      'genetic apex',
      'mythical island',
      'promo-a',
      'space-time smackdown',
      'triumphant light',
      'shining revelry',
      'celestial guardians',
      'extradimensional crisis',
      'eevee grove',
      'wisdom of sea and sky',
      'secluded springs',
      'deluxe pack ex',
      'mega rising',
      'promo-b'
    )
  end;
$$;

-- Trigger: enforce is_digital from set_name on insert and on
-- set_name change. Fires only when the relevant column changes, so
-- ordinary updates (mirrored URLs, search_doc_norm, etc.) skip it.
-- Overwrites any caller-supplied value for is_digital — the column
-- is a derived attribute, not a user-controlled flag.
-- Pattern matches the precedent in
-- 20260423055649_phase2f_derive_columns_trigger.sql.
create or replace function public.canonical_cards_set_is_digital_trigger()
returns trigger
language plpgsql
as $$
begin
  new.is_digital := public.canonical_set_is_digital(new.set_name);
  return new;
end;
$$;

drop trigger if exists canonical_cards_set_is_digital on public.canonical_cards;
create trigger canonical_cards_set_is_digital
  before insert or update of set_name on public.canonical_cards
  for each row
  execute function public.canonical_cards_set_is_digital_trigger();

-- Backfill existing rows. Expected to flip ~2,534 rows true based on
-- 2026-05-01 catalog inventory. WHERE clause guards against rewriting
-- rows that are already correct, so this is cheap to re-run.
update public.canonical_cards
set is_digital = true
where is_digital = false
  and public.canonical_set_is_digital(set_name);

-- No index. The dominant query is `where is_digital = false`, which
-- matches ~88% of rows — a B-tree wouldn't be selective enough for
-- the planner to use. Existing set_name and slug indexes already
-- carry the typical filter combinations.
