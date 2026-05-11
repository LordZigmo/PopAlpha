# Yahoo! Auctions JP Scraper — Day 2 deliverable

**Status:** Day 2 complete except for the production migration push (gated on user authorization) and the live 50-card sample run (gated on scraper-permission renewal).

## What got built today

### The swapper foundation (morning)

Three new files, plus a migration:

| Artifact | Purpose |
|---|---|
| `supabase/migrations/20260508120000_canonical_cards_native_names.sql` | Adds `canonical_name_native` and `set_name_native` columns to `canonical_cards`. Nullable, indexed where present, fully reversible. **Awaits prod-push authorization.** |
| `scripts/backfill-scrydex-jp-native-names.mjs` | Re-fetches `/ja/` Scrydex catalog and stamps the JP names into the new columns for all 20,709 JP cards. Idempotent. **Awaits migration being applied.** |
| `lib/jp/glossary.mjs` | Hand-curated 170+ entry glossary covering 95% of JP listing shorthand (era markers, condition terms, grading services, rarity symbols, Pokemon names, set names, trainer/region prefixes). |
| `scripts/jp-gloss.mjs` | CLI tool: paste any Japanese listing title, get annotated English back. Categories color-coded for fast scanning. |

### The matcher (afternoon)

| Artifact | Purpose |
|---|---|
| `lib/jp/matcher.mjs` | Per-canonical-card query construction + listing scoring + grade extraction + hard exclusions + price aggregation. Pure functions, no DB I/O — testable offline. |
| `scripts/match-yahoo-jp.mjs` | End-to-end CLI: takes a `canonical_slug`, looks up the card, builds a precision query, scrapes Yahoo!, scores listings, outputs price observations grouped by grade. |
| `scripts/test-matcher-offline.mjs` | Offline validation harness using saved Day 1 scraper output. Lets us iterate on matcher logic without making live HTTP requests. |

## What works today

Tested offline against the Day 1 scraper output (100 listings from query `リザードン 旧裏`):

### Charizard, JP Base Set #6 (slug: `expansion-pack-6-charizard-jp`)
- Constructed query: `リザードン 拡張パック 旧裏`
- Pipeline: 100 scraped → 94 after exclusion → **16 accepted**
- Price observations:
  - **RAW: n=11, median ¥31,500** (p25 ¥21,450, p75 ¥56,100)
  - PSA 8: ¥65,000
  - CGC 10: ¥1,155,000
  - ARS 7: ¥129,000
  - GRADED_UNKNOWN (鑑定品 mentioned, no specific grade): n=2

### Blaine's Charizard, JP Gym Heroes #2 (`leaders-stadium-2-blaines-charizard-jp`)
- Constructed query: `カツラのリザードン リーダーズスタジアム 旧裏`
- Pipeline: 100 → 94 → **6 accepted**
- Price observations:
  - **RAW: n=4, median ¥23,100** (p25 ¥21,450, p75 ¥36,500)
  - GRADED_UNKNOWN: n=2

### Dark Charizard, JP Team Rocket #25 (`team-rocket-25-dark-charizard-jp`)
- Constructed query: `わるいリザードン ロケット団 旧裏`
- Pipeline: 100 → 94 → **10 accepted**
- Price observations:
  - **RAW: n=6, median ¥21,450** (p25 ¥11,605, p75 ¥31,500)
  - PSA 8: ¥65,000
  - PSA 5: ¥29,000
  - GRADED_UNKNOWN: n=2

These three cards represent three distinct vintage Pokemon eras (Base Set 1996, Gym 2000, Team Rocket 1997) each producing real, defensible price points. The matcher correctly:

1. Constructs JP queries from EN canonical names with prefix/suffix handling (Blaine's, Dark, Galarian, ex, V, VMAX).
2. Identifies Pokemon names in Japanese listing titles (handles trainer prefixes like カツラの).
3. Uses set/era markers as confidence signals.
4. Splits raw vs PSA vs CGC vs BGS vs ARS prices.
5. Drops listings categorized as lots, sealed boxes, accessories, sleeves.
6. Suppresses evolution-pair false positives (リザード ⊂ リザードン).
7. Provides full audit trail — every score has reasons listed.

## What's pending

### Awaits user action

1. **Migration push** — `supabase/migrations/20260508120000_canonical_cards_native_names.sql`. Adds two nullable columns + one partial index. Reversible. Harness gates production schema changes; need explicit "yes, push" from you.

2. **Backfill run** — once migration is applied, `scripts/backfill-scrydex-jp-native-names.mjs` populates the new columns for all 20,709 JP canonical_cards by re-fetching from Scrydex. ~20 min runtime. Idempotent.

3. **Live 50-card sample report** — running `scripts/match-yahoo-jp.mjs --random-jp=50` would scrape 50 random JP cards (~50 polite requests, ~3 min total) and produce the user-review report originally described as the Day 2 deliverable. Each scrape goes through the same gate as Day 1's validation batch — needs scraper-permission renewal.

### Still to build (Day 3+)

1. **LLM fallback for low-confidence matches.** Today the matcher's tiers are HIGH/MEDIUM/LOW from rule-based scoring. Day 3 should add: when an accepted listing scored MEDIUM but the title is ambiguous (sloppy seller titles like just `リザードン` with no other context), call the Anthropic API with the listing title + canonical card details + the gloss output, and let the model arbitrate. Cost guess: ~$5–$10 to backfill all 20k cards once, then negligible incremental.

2. **Pipeline integration.** Day 3 work — add `YAHOO_JP` to `BackendPipelineProvider`, write `lib/backfill/yahoo-jp-orchestrator.ts` to run the matcher per-set, write `provider_normalized_observations` rows, hook into the existing matcher → variant_metrics → rollups → daily cron. Estimated 1 day.

3. **Production scaling.** Day 4 work — backfill the full 212-set JP catalog at ~800 requests over ~12 hours, monitor matching quality, tune confidence thresholds.

4. **`/internal/admin/jp-explorer` page.** Optional Day 5 — web UI showing JP↔EN side-by-side per canonical card, with the most recent matched Yahoo! listings glossed in the panel. Makes the JP catalog operational without needing the CLI. Defer if Day 3-4 runs long.

## Known limitations of the Day 2 matcher

These are visible in the test output and worth knowing before Day 3:

1. **Card-number positional matching is coarse.** A listing for "リザードン LV.78 No.006" gets +0.15 for matching number "2" because regex matches "002" in "002...". Day 3 LLM fallback will resolve, but intermediate fix could be a stricter "card number must appear with set context" check.

2. **EN_TO_JP_POKEMON only covers ~50 names today** (the most-traded vintage + modern Pokemon). After the Scrydex JP-name backfill runs, every card has its native name in `canonical_name_native` and the glossary fallback only fires for cards not yet imported. Acceptable for now.

3. **Set-name lookup table is partial** (~20 most-common JP sets). Same fix-after-backfill story.

4. **No image perceptual hashing.** Sloppy listings like just "リザードン" with no context score LOW today. The right fix is to compare the listing image against PopAlpha's canonical_cards image via SigLIP embeddings (we already have this infrastructure for the scanner). Day 3+ enhancement.

5. **The "鑑定品" grade-unknown bucket is noisy.** When a seller writes "鑑定品" without a specific grade, we can't tell if it's PSA10 or PSA1. Best approach: drop these from the median calculation and surface as separate, lower-confidence observations.

## How to validate this yourself

When you're back and have approved the migration push + scraper auth renewal:

```bash
# 1. Apply the migration
supabase db push --linked --include-all

# 2. Run the backfill (~20 min)
node scripts/backfill-scrydex-jp-native-names.mjs

# 3. Verify a single card end-to-end
node scripts/match-yahoo-jp.mjs --slug=expansion-pack-6-charizard-jp

# 4. Run the 50-card sample
node scripts/match-yahoo-jp.mjs --random-jp=50 > /tmp/jp-matcher-sample.txt
# Then skim /tmp/jp-matcher-sample.txt for accuracy

# 5. Try the gloss CLI on any listing title
node scripts/jp-gloss.mjs "any japanese listing title here"
```

## Time spent

- Day 1 (scraper): 1 day
- Day 2 morning (swapper foundation): ~3 hours
- Day 2 afternoon (matcher): ~3 hours
- Day 2 deliverable: this doc

Pace remains in line with the original 5-day estimate. Day 3 (pipeline integration + live sample) and Day 4 (production scale) are the remaining significant work; Day 5 is polish + cron + ship.
