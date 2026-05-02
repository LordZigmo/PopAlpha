-- 20260423030000_phase2e_fk_and_validate.sql
--
-- Phase 2e: lock down the new columns now that backfill (2c) is
-- complete, the view has been switched over (2d), and the insert
-- trigger (2f) guarantees future rows are populated correctly.
--
-- Actions:
--   1. Validate the finish CHECK constraint added NOT VALID in 2a.
--   2. Add a NOT VALID FK from price_history_points.printing_id ->
--      card_printings(id), then validate it.
--   3. Drop the Phase 1 picker function
--      preferred_canonical_raw_variant_ref — no callers remain after 2d.
--
-- Not enforcing NOT NULL on printing_id: ~1,879 slugs worth of
-- UNKNOWN-classifier rows (stamps / editions / artist promos) remain
-- intentionally NULL per the Phase 2 "Option A" scoping decision.
-- Phase 3 will extend the model to cover those dimensions; until then,
-- canonical view simply excludes them (NULL != anything in the filter).
--
-- Rollback: drop the FK, invalidate the CHECK (alter table ... drop
-- constraint), recreate preferred_canonical_raw_variant_ref from
-- migration 20260422200000.

-- Step 1: validate the finish CHECK (no table scan now — constraint
-- was NOT VALID; validating checks only existing rows, which are all
-- in the allowed set post-backfill).
alter table public.price_history_points
  validate constraint price_history_points_finish_chk;

-- Step 2: FK on printing_id.
alter table public.price_history_points
  add constraint price_history_points_printing_id_fkey
  foreign key (printing_id) references public.card_printings(id)
  on delete set null
  not valid;

alter table public.price_history_points
  validate constraint price_history_points_printing_id_fkey;

-- Step 3: drop the Phase 1 picker. Safe: confirmed no remaining callers
-- via grep across supabase/ and lib/. The new canonical view uses
-- preferred_canonical_raw_printing(slug) which returns a uuid directly.
drop function if exists public.preferred_canonical_raw_variant_ref(text);
