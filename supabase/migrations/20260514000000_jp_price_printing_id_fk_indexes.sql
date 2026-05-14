-- FK-coverage index on printing_id for the JP price companions.
--
-- Background: when yahoo_jp_card_prices and snkrdunk_card_prices were
-- shipped (PRs #44 and #49 respectively), both gained a nullable
-- `printing_id uuid REFERENCES card_printings(id) ON DELETE CASCADE`
-- column. Both tables ALSO got a natural-key UNIQUE INDEX on
-- (canonical_slug, printing_id, grade) WITH NULLS NOT DISTINCT — but
-- the leading column there is canonical_slug, not printing_id.
--
-- Migration-reviewer agent flagged on both PR #44 and PR #49 that
-- DELETE on a card_printings row would trigger ON DELETE CASCADE
-- which does a sequential scan of yahoo_jp_card_prices /
-- snkrdunk_card_prices to find rows with that printing_id. The
-- natural-key index can't serve this lookup because canonical_slug
-- isn't the predicate.
--
-- Today this is a slow path that's rarely hit (card_printings deletes
-- are extremely rare in this codebase). But it's also cheap to fix —
-- one partial index per table, neither table is large. Pre-emptive
-- correctness vs. unbounded scan exposure if a printing-deletion ever
-- runs in bulk.
--
-- Partial WHERE printing_id IS NOT NULL because the canonical-rollup
-- rows (printing_id NULL) never match the FK-cascade predicate.

CREATE INDEX IF NOT EXISTS yahoo_jp_card_prices_printing_id_idx
  ON public.yahoo_jp_card_prices (printing_id)
  WHERE printing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS snkrdunk_card_prices_printing_id_idx
  ON public.snkrdunk_card_prices (printing_id)
  WHERE printing_id IS NOT NULL;
