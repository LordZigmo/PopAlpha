# Grader-Split Playbook

**Audience:** Future Claude (or any engineer) touching graded pricing — the per-grader (PSA / CGC / BGS / TAG) price surface for graded cards, its bounded refresh, the web ladder route, and the iOS graded detail.

**Last updated:** 2026-06-05 — initial entry, documenting the grader-split architecture shipped in PRs #189 / #190 / #191 / #192.

---

## Why this file exists

`card_metrics` is keyed by `(canonical_slug, printing_id, grade)` with **no grader dimension**. A graded "G10" row therefore medians PSA 10 + CGC 10 + BGS 10 + TAG 10 into a single pooled number that corresponds to no real market (Gym Challenge Rocket's Zapdos G10: PSA ~$3,431, CGC ~$761, TAG ~$1,000, all collapsed to a meaningless midpoint). Tapping a grading agency in the iOS detail re-pointed the chart but left the headline price pooled.

Grader-split adds an **isolated** per-`(printing, grader, grade)` price surface so each agency shows its own price, without touching `card_metrics` or any of its many consumers (homepage / holdings / RAW headline stay exactly as they were). "Good" here means: the right grader's price shows, the pick is stable across requests, the refresh never times out, and we never invent a graded change badge on sparse data.

This is the **grader** dimension. The orthogonal **RAW per-printing** isolation work (`refresh_per_printing_raw_price_display`, PR1/5) is a sibling pattern — same bounded/watermark shape — documented in `docs/canonical-raw-price-variant-selection.md`.

---

## The architecture (one paragraph)

`graded_variant_prices` is a new table keyed by `(canonical_slug, printing_id, grade, grader)` holding `latest_price`, `market_price` (14d median, the headline), `median_7d / 30d`, `low_30d / high_30d`, `snapshot_count_30d`. It is fed by `refresh_graded_variant_prices(p_max_cards)` — a bounded, watermark-paced RPC that drives off `variant_metrics` (the small graded-combo source, where `provider` **is** the grader), scopes the price aggregation to the picked slugs, and parses grader+bucket+printing straight out of `variant_ref`. A side table `graded_variant_prices_refresh_state` is the watermark; `public_graded_variant_prices` is the anon/auth read view. Consumers: the web ladder route (`app/api/cards/[slug]/ladder/route.ts`) emits per-grader price in `graders[]` (#191); iOS reads the view directly via `CardService.fetchGradedCardMetrics`, keys `gradedCardMetricsByBucket` by `"GRADER::bucket"`, and `gradedMarketSummarySection` looks up the selected provider so the agency pills change the number (#192).

Migration: `supabase/migrations/20260605050000_graded_variant_prices.sql`. Cron: `app/api/cron/refresh-graded-variant-prices/route.ts`.

---

## Incidents / non-obvious learnings

### 2026-06-05 — `schema-guardrails` CI links LIVE PROD, so new-object classification must land in a follow-up PR

**Symptom:** A migration that adds a table/view plus its classification in `scripts/security-guardrails.config.mjs` in the *same* PR fails CI with "listed in contract but does not exist in schema public" — even though the migration is committed and correct.

**Root cause:** The `schema-guardrails` job in `ci.yml` runs `check:security:schema`, which **links the production database** and enumerates every live `public` table/view, then requires each one to appear in the RLS / grant / view contract sets in `security-guardrails.config.mjs` — and vice versa. On a PR build, the migration has not applied to prod yet, so any object you pre-list in the contract is "in the contract but not in the schema." It's a chicken-and-egg ordering, not a config typo.

**Fix:** Split it. The migration PR registers only the **route** (route-registry + the route guardrails), and deliberately omits the schema-object classification. A follow-up PR adds the new objects to the RLS/grant/view contract sets **after** the migration has applied to prod. #189 (aa3d79e) shipped the migration with the route classification only; #190 (8d28f41) added `graded_variant_prices`, `graded_variant_prices_refresh_state`, and `public_graded_variant_prices` to the schema-contract sets post-merge.

**Generalization:** Adding a new `public` table/view is a **two-PR sequence**, never one. PR-A: migration + route registration. PR-B (after PR-A applies to prod): classify the new objects in the schema-contract sets. This is the same sequencing the Snkrdunk tables used. `npm run check:security:static` (the local guard) does **not** catch this because it doesn't link prod — only the CI `schema-guardrails` job does, so a green local check is not sufficient confidence here.

---

### 2026-06-05 — Bounded-cron sizing over a 5M-row table: 4000 drains, 10000 sticks forever

**Symptom:** `refresh_graded_variant_prices(10000)` exceeds the 300s cron ceiling (and the MCP gateway's shorter ~2min timeout when run manually). Because the watermark only advances **on success**, a timed-out tick makes zero progress — and since it picks the *stalest* cards first, it picks the same stuck cards next tick. The table stays perpetually un-refreshed.

**Root cause:** The price source `variant_price_daily` is ~5M rows. The refresh scopes its `::GRADED::` parse to the picked slugs via an index join, which is cheap at small N — but a large per-tick scope (`p_max_cards = 10000`) flips the planner to a **full scan** of `variant_price_daily` instead of the index-backed scoped path, blowing the time budget. Measured post-deploy: 4000 finishes comfortably, 10000 does not.

**Fix:** `DEFAULT_MAX_CARDS = 4000` in the cron route and `?maxCards=4000` in `vercel.json` (#190 dropped both from 10000). At 4000, a full cycle over the ~24k graded cards is ~6 ticks / ~12h on the `30 */2 * * *` schedule — fine for daily-cadence graded data (`variant_price_daily` itself is refreshed daily by refresh-set-summaries at 09:00 UTC, so there is no fresher source to chase).

**Generalization:** For any bounded, watermark-paced refresh: the batch size is bounded by **planner stability**, not just wall-clock. There is a cliff where a larger scope flips an index scan to a seq scan and the per-row cost jumps an order of magnitude — find it empirically and size *under* it, don't extrapolate linearly from a small run. And because a stalest-first watermark only advances on success, a too-large batch doesn't just "run slow," it **deadlocks the cursor on the same stale cards forever**. When you backfill manually through the MCP gateway, use an even smaller `p_max_cards` than the cron — the gateway timeout (~2min) is shorter than the cron's 300s.

---

### 2026-06-05 — `variant_ref` has two dialects for graded prices; ingest both or silently drop cards, but dedupe or double-count the sample size

**Symptom (latent, prevented):** Graded prices for a `(printing, grader, grade)` combo live under **two different `variant_ref` encodings**. Parse only one and you silently drop whole cards from the graded surface. Ingest both naively and the same sale is counted twice, inflating `snapshot_count_30d` (the sample size the iOS graded summary shows).

**Root cause:** Two writers produce graded refs in different shapes:
- **Long form** (dominant): `<printing_id>::<set-pt>::GRADED::<grader>::<bucket>::RAW` — verified ~810,605 rows / 24,763 cards in prod. Here **grader = segment 4, bucket = segment 5**, and the bucket is already in the G-vocabulary (`G10`, `G9_5`, `LE_7`, ...).
- **Canonical short form**: `<printing_id>::<grader>::<grade_token>` — ~3k rows / 43 cards, written by `buildGradedVariantRef` + the scheduled Scrydex daily pipeline. Here **grader = segment 2, token = segment 3**, and the token vocabulary is different (`10`, `10_PERFECT`, `9_5`, `9`, `8`, `7_OR_LESS`). The short form is exactly 3 segments (segment 4 is empty).

A combo can carry **both** refs for the same sale.

**Fix:** `refresh_graded_variant_prices` parses both forms with a `like '%::GRADED::%'` discriminator (long → seg4/seg5; short → seg2/seg3, with the token normalized into the G-vocabulary so it filters identically to the iOS view). It then dedupes to **one close per `(printing, grader, grade, day)`** via `distinct on (...) order by ..., form_rank, close_price desc`, where `form_rank = 0` for the long form and `1` for the short form — so when both refs exist for one day, the long form wins and the day is counted once. Without this, `snapshot_count_30d` double-counts.

**Generalization:** `variant_ref` is not a single stable grammar — it's a union of encodings from different writers across the codebase's history. Before parsing it by segment position, confirm **every** dialect in prod (`select distinct ... from variant_price_daily where variant_ref like ...`) and which segment carries what in each. When two dialects can describe the same observation, pick a deterministic `form_rank` tie-break and dedupe before any `count`/`sum`, or you inflate sample sizes — which directly undermines the "is this price trustworthy" signal.

---

### 2026-06-05 — No per-grader change_pct, by design (sparsity, not an oversight)

**Symptom (deliberate omission):** There is no 24h / 7d change badge on the graded surface — web or iOS. Reviewers may flag it as "missing."

**Root cause:** Graded series are sparse — most `(printing, grader, grade)` combos have **1–6 sales over 30 days**. A 24h or 7d "change" on that data compares a single datapoint to itself, or to noise, and produces a confident-looking number that means nothing.

**Fix:** `graded_variant_prices` deliberately carries **price + 14d/7d/30d medians + 30D range + sample count only** — no change column. iOS shows no graded change badge. This matches the pre-existing graded behavior; the surface didn't have a change badge before either.

**Generalization:** A change percentage is only honest when the window has enough independent observations to distinguish signal from noise. On sparse series, omit it rather than compute it with a flag — per the north-star trust principle, an absent number beats a misleading one. If graded volume ever densifies, a follow-up can add change with a sparse-aware baseline; YAGNI until then.

---

### 2026-06-05 — Per-grader "most-traded printing" can resolve DIFFERENT printings per grader; expose `printing_id` so a cross-grader gap isn't misread as a grade premium

**Symptom:** On a multi-printing card, the dominant-printing pick can land on a *different printing* for different graders. Zapdos: PSA G10's most-traded printing resolves to 1st-Edition (~$3,431), while CGC G10's resolves to Unlimited (~$27). Naively, the PSA-vs-CGC gap looks like a ~127× grade-quality premium — it's mostly a 1st-Ed-vs-Unlimited **printing** difference.

**Root cause:** Each grader's price is collapsed to its own "dominant printing" independently (a slug-level framing: "what does THIS grader's <grade> of <slug> trade at"). Nothing forces all graders onto the same printing, and for sparse multi-printing cards they routinely diverge.

**Fix:** The web ladder exposes `graders[].printing_id` (labeling *which* printing each grader's price came from) plus a `data_quality_note` that explicitly warns: *"for multi-printing cards different graders can resolve to different printings, so do not read a cross-grader gap as a pure grade premium without checking printing_id."* This is primarily for the LLM that consumes the ladder — so it doesn't narrate a printing gap as a grading-quality gap.

**Generalization:** Any time you collapse a multi-dimensional key to a "dominant" representative per facet, the representatives across facets may not share the other dimensions — and a naive cross-facet comparison silently conflates two variables. Surface the collapsed-away dimension (here, `printing_id`) in the payload and flag the conflation risk explicitly, especially when an LLM reads the output.

---

## The shared dominant-printing tie-break (web + iOS must stay identical)

For a slug with multiple printings of one grader+grade, both consumers pick the dominant printing with the **same strict total order** so the pick is stable across requests (Supabase returns these rows unordered, so without a total order the chosen printing — and its price — flips on DB row order across requests/plans):

1. Prefer a row that **has** a usable 14d `market_price` (a sparse printing with many obs in days 15–30 but none in the last 14 has a null 14d median and loses to one that has it).
2. Then higher `snapshot_count_30d`.
3. Then freshest `market_price_as_of ?? latest_price_as_of` (ISO timestamps sort chronologically).
4. Then `printing_id` as the final deterministic tiebreaker.

- **Web:** `dominantPriceWins(cand, cur)` in `app/api/cards/[slug]/ladder/route.ts`.
- **iOS:** the `candidates.max { ... }` closure in `CardDetailView.swift`'s `gradedCardMetricsByBucket` load.

**Gotcha that already bit us (Codex P2 on #192):** iOS first compared only `marketPriceAsOf` and dropped `latest_price_as_of` from its select — so for sparse rows with no 14d median that tie on `snapshot_count_30d`, iOS fell straight to `printing_id` while the web ladder used `market_price_as_of ?? latest_price_as_of`. That let iOS pick a different (older) printing and show stale median/range/as-of than the web ladder for the same card. **If you change this tie-break, change it in both places and keep the exact same fallback chain** — including selecting/decoding every field the comparison reads. A divergence here is invisible in code review and only shows up as web and iOS disagreeing on a sparse card's price.

---

## Consumer notes

- **iOS keying:** `gradedCardMetricsByBucket` is keyed by `"GRADER::bucket"` (e.g. `"PSA::G10"`), not bucket alone — that's the whole point, so the pills change the price. `GradedCardMetricRow.id` includes the grader (`"\(slug)::\(printing)::\(grade)::\(grader)"`) so PSA/CGC rows for the same printing+grade don't collide in SwiftUI. The summary **leads with the 14d median** (`market_price`), because graded 7d windows are frequently empty on sparse combos. iOS reads `public_graded_variant_prices` directly — no API route in between (`CardService.fetchGradedCardMetrics`).
- **Web ladder:** `graders[]` carries each grader's `printing_id`, `latest_price_usd`, `market_price_usd`, `median_7d/30d_usd`, `low/high_30d_usd`, `price_snapshot_count_30d`, `price_as_of`. The grade-rung *headline* is still the cross-grader `card_metrics` aggregate — the per-grader spread lives in `graders[]`. A grader appears in `graders[]` if it has **either** a price row (`public_graded_variant_prices`) **or** an activity row (`variant_metrics`); the two are resolved by separate dominant-printing picks (`dominantPriceWins` for price, `dominantActivityWins` for activity), so a grader's price-printing and activity-printing can differ.

---
