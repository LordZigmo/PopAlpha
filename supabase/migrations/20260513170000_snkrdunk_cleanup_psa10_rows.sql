-- Cleanup orphan grade='PSA10' rows in snkrdunk_card_prices.
--
-- Background: PR #49 shipped the matcher emitting label='PSA10' for
-- Snkrdunk's "PSA 10" condition. That label does not match the
-- card_metrics.grade convention (which uses the G-prefix bucket form:
-- G10, G9, G9_5, ...), so the public_card_metrics view's
-- JOIN ON cm.grade = snk.grade returned NULL for those rows.
--
-- PR #50 corrects the matcher to emit 'G10'. But the runner's freshness
-- filter (scripts/run-snkrdunk-pipeline.mjs lines 72 + 150-155) skips
-- by canonical_slug alone — so any slug with a recent PSA10 row would
-- be skipped on the next run, and the new G10 row would never be
-- written. Codex P2 on PR #50.
--
-- Fix: one-shot DELETE of any existing grade='PSA10' rows. After this
-- migration applies, future writes use grade='G10' via the corrected
-- matcher. The DELETE is idempotent — re-running yields zero rows.
--
-- In prod today this is a no-op (the only PSA10 rows ever written were
-- from a smoke-test on one slug, which I manually deleted before
-- re-running with the G10 matcher). The DELETE is defensive for any
-- environment where prior PSA10 writes may exist (dev/staging, or any
-- future bucket-rename incident).

DELETE FROM public.snkrdunk_card_prices
WHERE grade = 'PSA10';
