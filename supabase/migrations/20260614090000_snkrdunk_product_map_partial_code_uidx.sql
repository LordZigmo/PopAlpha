-- Snkrdunk product-code uniqueness → partial (MATCHED rows only).
--
-- Why: persist-snkrdunk-matches.mjs (Step C) used to drop matched rows on
-- product-code collisions — the 2026-05-14 seeding run lost 337 of 8,123
-- persistable rows that way (6,451 matched + 1,672 needs-review vs 7,786
-- persisted). The 2026-06 recall batch changes Step C to keep the
-- higher-scoring claimant as MATCHED and persist the loser as NEEDS_REVIEW
-- with a conflict note, instead of silently dropping it. That requires the
-- loser row to be able to HOLD the same snkrdunk_product_code as the winner
-- while it waits for operator review.
--
-- The integrity property the full unique index protected — "never
-- double-claim one Snkrdunk product for two canonicals" — only matters for
-- rows the orchestrator ingests, and run-snkrdunk-pipeline.mjs reads
-- mapping_status='MATCHED' exclusively (NEEDS_REVIEW/REJECTED are skipped).
-- Scoping the uniqueness to MATCHED preserves that guarantee exactly where
-- it is load-bearing and unblocks the conflict-loser review queue.
--
-- Safe to apply: the full index guaranteed no duplicates exist today, so
-- the partial index always builds. The table is small (~8k rows) — no
-- CONCURRENTLY needed inside the migration transaction.

DROP INDEX IF EXISTS public.snkrdunk_product_map_product_code_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS snkrdunk_product_map_product_code_matched_uidx
  ON public.snkrdunk_product_map (snkrdunk_product_code)
  WHERE mapping_status = 'MATCHED';

COMMENT ON INDEX public.snkrdunk_product_map_product_code_matched_uidx IS
  'One MATCHED mapping per Snkrdunk product (Step D ingests MATCHED only). '
  'NEEDS_REVIEW rows may share a product code with the MATCHED winner: '
  'Step C demotes conflict losers to NEEDS_REVIEW with a conflict note '
  'instead of dropping them (2026-06 recall batch).';
