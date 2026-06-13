-- 20260615120000_grade_aliases_grader_strings.sql
--
-- Fix: graded cards silently fail to add to a portfolio from the iOS app.
--
-- Root cause: the iOS add-holding sheet sends the human-readable grade string
-- the user selected — "PSA 10", "CGC 9.5", "BGS 10", etc. (spaced, grader-
-- prefixed forms from ios/PopAlphaApp/HoldingsModels.swift GradeOption). The
-- holdings table has a BEFORE INSERT trigger (trg_set_grade_id ->
-- set_grade_id_from_grade -> resolve_grade_id, 20260509000000) that raises a
-- check_violation for any grade string that is neither a grade_definitions.code
-- nor a grade_aliases.alias. The catalog (20260508180000) only seeds RAW,
-- PSA9, PSA10 codes plus the G-prefix aliases (G8..G10_PERFECT) — it has NO
-- spaced grader forms and NO CGC/BGS rows at all. So every graded option the
-- iOS sheet can pick aborts the insert; the route returns 400 and the sheet
-- surfaces it only as a small caption, which reads to the user as "nothing
-- happened." RAW works because "RAW" is a catalog code. (The web portfolio is
-- immune: it restricts grades to RAW/PSA9/PSA10, all catalog-valid.)
--
-- Fix (additive, server-only — the existing TestFlight build works after this
-- applies, no rebuild): teach the catalog the standard grader-grade strings as
-- ALIASES mapping to the appropriate existing grade_id. The user's typed string
-- (e.g. "CGC 10") is stored verbatim in holdings.grade for display — grader
-- identity is preserved — while grade_id resolves to the tier bucket, matching
-- how the read/valuation paths already normalize grade (grader-agnostic today,
-- lib/holdings/grade-normalize.ts). PSA 9 / PSA 10 map to the PSA-specific
-- definitions (ids 8/9) that already exist; CGC/BGS map to the grader-agnostic
-- tier buckets (no CGC/BGS definitions exist yet).
--
-- resolve_grade_id does an EXACT string match (no case-fold/trim) and the route
-- already trims, so the alias text must match the iOS rawValues verbatim.
--
-- Forward note (NOT done here, deliberately): to value PSA 10 vs CGC 10 vs
-- BGS 10 at their distinct grader-split prices, holdings would need
-- grader-specific grade_ids (the catalog reserves ids 10+ for "future
-- grader-specific entries (BGS_9_5, CGC_10, ...)") and the valuation join would
-- key on grade_id. That is a feature, not this bug — this migration only
-- unblocks the add and keeps the grader string intact for display.
--
-- Purely additive: inserts into the existing grade_aliases table. No function
-- redefinition, no column/constraint change, no backfill (the 4 existing
-- holdings rows are already RAW/PSA9/PSA10 and passed the resolver).

insert into public.grade_aliases (alias, grade_id) values
  ('PSA 7',   2),  -- 7_OR_LESS bucket (no PSA7 definition; tier <= 7)
  ('PSA 8',   3),  -- 8 bucket (no PSA8 definition)
  ('PSA 9',   8),  -- PSA9 definition (PSA-specific, id 8)
  ('PSA 10',  9),  -- PSA10 definition (PSA-specific, id 9)
  ('CGC 9',   4),  -- 9 bucket
  ('CGC 9.5', 5),  -- 9_5 bucket
  ('CGC 10',  6),  -- 10 bucket
  ('BGS 9',   4),  -- 9 bucket
  ('BGS 9.5', 5),  -- 9_5 bucket
  ('BGS 10',  6)   -- 10 bucket
on conflict (alias) do nothing;
