-- 20260513140000_sets_legacy_curation.sql
--
-- Curate era + release_date on 3 sets that the Scrydex /expansions API can't
-- bridge to via either name-match (PR #39) or set_code → expansion.id
-- (PR #41).
--
-- Investigation: these 3 are sparse "legacy seed" rows in public.sets backed
-- by 1–2 card_printings each with source='seed' and uppercase non-Scrydex
-- set_codes (BS1, SV2A, EVO). All three are duplicates of properly-populated
-- sets that the Scrydex pipeline owns:
--
--   base-set            (2 printings, EN, set_code BS1)
--     duplicate of:     base (128 printings, era='Base', 1999-01-09)
--
--   pokemon-card-151    (1 printing,  JP, set_code SV2A)
--     duplicate of:     pok-mon-card-151 (516 printings, era='Scarlet & Violet', 2023-06-16)
--
--   xy-evolutions       (2 printings, EN, set_code EVO)
--     duplicate of:     evolutions  (217 printings, era='XY', 2016-11-02)
--
-- Two paths to fix: (a) consolidate the duplicates per the set-merge playbook
-- in 20260509170000_card_printings_set_id_fk.sql by remapping the 5 fixture
-- card_printings to the canonical set_name, or (b) curate era/release_date
-- directly on the duplicate sets row.
--
-- This migration takes path (b) — small, idempotent, doesn't risk touching
-- test-fixture card_printings rows that downstream tests may reference by
-- their existing slugs. Future cleanup can consolidate the duplicates via
-- path (a) once we've audited which tests depend on the fixtures.
--
-- source='curated_legacy' is on the refresh_sets_for_set_ids denylist (see
-- 20260509150000:source case) so future card_printings churn preserves
-- these values. Idempotent: only writes when era is currently NULL, so
-- re-runs are no-ops.

update public.sets
   set era = 'Base',
       release_date = '1999-01-09',
       source = 'curated_legacy',
       updated_at = now()
 where set_id = 'base-set' and era is null;

update public.sets
   set era = 'Scarlet & Violet',
       release_date = '2023-06-16',
       source = 'curated_legacy',
       updated_at = now()
 where set_id = 'pokemon-card-151' and era is null;

update public.sets
   set era = 'XY',
       release_date = '2016-11-02',
       source = 'curated_legacy',
       updated_at = now()
 where set_id = 'xy-evolutions' and era is null;
