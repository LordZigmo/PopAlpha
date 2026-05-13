-- Cleanup orphan grade='PSA10' rows + sibling rows for affected slugs.
--
-- Background: PR #49 shipped the matcher emitting label='PSA10' for
-- Snkrdunk's "PSA 10" condition. That label does not match the
-- card_metrics.grade convention (which uses the G-prefix bucket form:
-- G10, G9, G9_5, ...), so the public_card_metrics view's
-- JOIN ON cm.grade = snk.grade returned NULL for those rows.
--
-- PR #50 corrects the matcher to emit 'G10'. But the runner's freshness
-- filter (scripts/run-snkrdunk-pipeline.mjs lines 72 + 150-155) skips
-- by canonical_slug alone — so any slug with a recent row of ANY grade
-- gets skipped on the next run.
--
-- v1 of this migration only deleted grade='PSA10'. Codex P2 follow-up
-- on PR #50 pointed out that a prior run typically wrote BOTH a RAW
-- and a PSA10 row for the same slug in one pass, so deleting only the
-- PSA10 row leaves the RAW row's observed_at within the freshness
-- window. The slug then gets skipped and the corrected G10 row is
-- never written until the 24h window expires (or the operator
-- remembers to pass --skip-fresher-than-hours=0).
--
-- Fix: delete ALL rows for any slug that had a PSA10 row, not just
-- the PSA10 row itself. This forces the next pipeline run to do a
-- fresh fetch + write for those slugs, producing the corrected G10
-- row plus a fresh RAW row in the same pass.
--
-- In prod today this is a no-op (the only PSA10 rows ever written
-- were from a smoke-test on one slug, which I manually deleted before
-- re-running with the G10 matcher; that slug now has a single RAW row
-- with grade='RAW' and no PSA10 row, so the WHERE clause matches zero
-- rows). Defensive for any environment where prior PSA10 writes may
-- exist (dev/staging, or any future bucket-rename incident).
--
-- Idempotent — re-running yields zero rows once the cleanup has happened.

DELETE FROM public.snkrdunk_card_prices
WHERE canonical_slug IN (
  SELECT DISTINCT canonical_slug
  FROM public.snkrdunk_card_prices
  WHERE grade = 'PSA10'
);
