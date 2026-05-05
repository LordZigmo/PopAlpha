# Graded Pricing Surfacing Plan

_Created 2026-05-05. Companion to the dated coverage reports at `docs/graded-pricing-coverage-YYYY-MM-DD.md` produced by [`scripts/report-graded-pricing-coverage.mjs`](../scripts/report-graded-pricing-coverage.mjs)._

## Context

The user's intent: "graded should be priced under another section, with its own market summary." The previous RAW-only exclusion (commit `cbefdec`) was correct because graded was bleeding into the RAW chart line. We need to surface graded data in its own dedicated section without re-introducing that bleed.

**Critical correction from the v1 coverage report:** the Grade Board chart already works. `price_history_points` has 1,656,671 graded rows powering both the web and iOS Grade Board chart, and Tropical Beach BW28 is rendering fresh prices (PSA G9 $1,168.73, PSA G8 $3,600, CGC LE_7 $325, etc., observed 2026-05-04). The "0 of 58,586 history points" finding was a script bug — `history_points_30d` is an integer count, not a JSONB array.

**The actual gap, in order of user impact:**

1. **API routes hard-code `grade='RAW'`** (`/api/holdings/summary`, `/api/pro/signals`, `/api/market/snapshot` history confidence, `/api/portfolio/overview`'s `marketPulseMap`, daily top movers). The first graded user holding will be valued at the RAW market price.
2. **No richer market-summary panel** beyond the chart + provider tiles. We have median 7d/30d, low/high 30d, sample size already computed in `card_metrics` for graded — they're just not exposed in a dedicated graded summary view.
3. **Signals (`signal_trend`, `signal_breakout`, `signal_value`) are 0 of 58,586 for graded** because the existing calculator requires `history_points_30d >= 10` per (slug, variant_ref, provider, grade) and graded variants typically have 1–2 points.

**What this plan does NOT do** (verified via investigation):
- Does NOT build a parallel graded analytics writer. The chart-data writer is fine — `price_history_points` already accumulates graded rows correctly.
- Does NOT modify the RAW analytics writer ([`lib/backfill/provider-observation-variant-metrics.ts:144-157`](../lib/backfill/provider-observation-variant-metrics.ts)) or the RAW chart view (`public_price_history_canonical`). Those exclusions are correct and protect against bleeding.
- Does NOT touch `price_snapshots` or `provider_normalized_observations` ingestion paths.

## Operating constraints

The runbook and incident history make the CPU/IO budget extremely tight:

- `price_history_points` was the main CPU culprit (13M rows / 8.3GB / 113 CPU hours/day on medium compute) until commit `7f557aa` downsampled it to 1 point per (variant, day) older than 30 days. Anything that re-grows this table is high-risk.
- Recent throughput-raising commit (`539ff00`) tuned obs caps to 250 / drain rate to 9k/hour ceiling vs 4–5k/hour enqueue. We are not in a state where adding new rollup load is free.
- `pipeline_jobs` queue has built-in de-escalation (≥4 attempts → MINIMAL 40 obs, ≥2 → RETRY 80 obs, else PIPELINE 250 obs) and a 300s stale-reclaim window. Any new job must integrate with this rather than running unbatched.
- Per the user's instruction: "I don't want to blow up the database or our CPU usage." Therefore the plan prefers READ-only or read-mostly changes, defers anything that touches `price_history_points` writes until later phases, and gates every phase on verified low CPU before unlocking the next.

## Phases

Each phase is self-contained and shippable. **Do not start phase N+1 until phase N has been deployed and observed for at least one week without CPU regression.**

---

### Phase 0 — Verification & instrumentation (zero write impact) — **DONE 2026-05-05**

**Goal:** Confirm the corrected coverage report numbers, lock down assumptions before changing code.

**Tasks:**
1. ✓ Re-ran [`scripts/report-graded-pricing-coverage.mjs`](../scripts/report-graded-pricing-coverage.mjs). Confirmed: 1,656,671 graded `price_history_points` rows; 0 of 58,586 graded `variant_metrics` rows have `signal_trend`; 58,156 of 58,586 (99.3%) have `history_points_30d > 0`. Script now writes to a dynamically-dated filename (`docs/graded-pricing-coverage-YYYY-MM-DD.md`) so historical snapshots accumulate, and emits pure data only — narrative findings live here in this plan, not in the auto-generated report.
2. ✓ Traced the non-PSA graded `variant_metrics` rows. Conclusion: **the 58,156 graded rows are a frozen one-time snapshot from 2026-04-15 03:29-03:31 UTC**, written during the brief window between commit `0be0572` (2026-04-13, enabled graded write path) and commit `33cc91b` (2026-04-16, reverted it). The PSA cert ingest path was never the source — it only writes `provider='PSA'` and `psa_certificates` is empty. There is no continuous writer for graded `variant_metrics`. Latest `updated_at` is **482h (~20 days) old** as of 2026-05-05.
3. ✓ Confirmed `psa_certificates` exact count = **0**. The PSA cert ingestion path has never produced a row. The 27,019 `provider='PSA'` `variant_metrics` rows came from the same 2026-04-15 batch as the other providers.
4. ✓ Shipped [`/api/debug/graded-coverage`](../app/api/debug/graded-coverage/route.ts). Cron-secret authed, runs in ~2.1s end-to-end (well under Vercel timeout), correctly flags 3 issues (signals=0, 482h staleness, psa_certificates empty). Registered in `lib/auth/route-registry.ts` + `scripts/security-guardrails.config.mjs`. `npm run check:security:static` passes.

**Surprise finding from Phase 0:** All 58,156 graded `variant_metrics` rows have `provider_as_of_ts` of 2026-04-15. By **2026-05-15** (~10 days from now), the Grade Board's "as of" timestamps will all be > 30 days old. We must either ship a parallel graded analytics writer (Phase 4) or accept that the metadata staleness is permanent. The chart itself remains fresh because `price_history_points` writer ([`lib/backfill/scrydex-price-history.ts:1494`](../lib/backfill/scrydex-price-history.ts)) continuously writes graded chart points — it's just the variant-metadata layer that's frozen.

**Risk:** None. All read-only.

**Done.**

**Rollback:** Delete `app/api/debug/graded-coverage/route.ts` and remove its entries in `lib/auth/route-registry.ts:106` and `scripts/security-guardrails.config.mjs:490` (route registry + DEBUG_ROUTE_TRUST_CONTRACTS) and `scripts/security-guardrails.config.mjs` (OPERATIONAL_SCRIPT_TRUST_CONTRACTS for the report script).

---

### Phase 1 — Graded Market Summary API + UI panel (read-mostly)

**Goal:** Expose the per-grade summary stats we already compute (`card_metrics.median_7d`, `median_30d`, `low_30d`, `high_30d`, `trimmed_median_30d`, `snapshot_count_30d`) in their own dedicated panel.

**Backend:**
- New route `/api/market/graded-summary` (public-read tier, returns `{ slug, byProvider: { PSA: { G10: {median7d, median30d, low30d, high30d, points30d, asOf}, ... } } }`).
- Implementation: a single `public_card_metrics` query with `.in('grade', ['LE_7','G8','G9','G9_5','G10','G10_PERFECT'])` filtered by slug and provider. Optionally a second query against `public_variant_metrics` for `provider_as_of_ts` freshness.
- Caching: identical pattern to `/api/market/snapshot` — Next.js `cache: 'no-store'` and rely on PostgREST hot-cache.
- Update [route registry + guardrails config](../docs/security) for the new route. Run `npm run check:security:static` before commit.
- iOS-parity: APIClient.swift gets a matching decode struct; spot-check ios-parity-checker.

**Web UI:**
- Update [`app/c/[slug]/page.tsx`](../app/c/[slug]/page.tsx) GRADED viewMode block (line 1143–1232). Add a stat strip below the existing provider tiles showing for the active (provider, bucket): median 7d / median 30d / 30d range / sample count / last-observed timestamp. Mirror the existing RAW market summary's visual style for consistency.
- Source data from the new `/api/market/graded-summary` response (kept separate from RAW snapshot to avoid any blend). Render only when graded data exists.

**iOS UI:**
- Add a `fetchGradedMarketSummary(slug:)` method on `CardService` ([CardService.swift:184](../ios/PopAlphaApp/CardService.swift)).
- Render a `GradedMarketSummaryView` as a section under the existing graded provider tiles in `CardDetailView`. Same visual structure as the RAW market summary. Decode struct must mirror APIClient.swift parity check.

**Risk:** Low.
- New API route adds at most one `public_card_metrics` SELECT per Grade Board page view. The table is small (~180k rows total), indexed on `(canonical_slug, grade)`. Estimated p95 latency <30ms.
- No writes, no new cron jobs.
- New UI components are additive; users not on the Grade Board are unaffected.

**Done when:**
- `/api/market/graded-summary` returns expected shape for 5 spot-checked slugs.
- Web Grade Board renders the new panel in dev for Tropical Beach BW28 and at least 2 other graded cards.
- iOS Grade Board renders parity panel.
- One week of `query-pg-stat-statements` shows `<0.5%` of total exec time on the new query.

**Rollback:** Remove the new route + panel; UI gracefully omits the section if the fetch fails.

---

### Phase 2 — Holdings valuation correctness (latent bug fix)

**Goal:** When a user has a graded holding, value it at the **graded** market price, not RAW.

**Today:** [`/api/holdings/summary:97,106`](../app/api/holdings/summary/route.ts) hard-codes `eq("grade", "RAW")` for the `public_card_metrics` lookup that drives `marketPriceMap`. Same pattern in [`/api/portfolio/overview`](../app/api/portfolio/overview/route.ts) via its `marketPulseMap`. Currently 0 graded holdings exist in production, so impact is theoretical — but the first graded entry will be mis-valued.

**Tasks:**
1. In `/api/holdings/summary`, change the `public_card_metrics` query from a single grade='RAW' filter to a per-holding-grade lookup. Strategy:
   - Build `slug_grade_pairs = [(slug, normalizedGrade(holding.grade))]` from the holdings list, dedupe.
   - Issue ONE query: `.in('canonical_slug', slugs).in('grade', uniqueGrades)`, then index by `(canonical_slug, grade)` client-side.
   - Same pattern for the `public_variant_movers_priced` hot-mover lookup, but defer until Phase 4 (signals) — for now, hot-mover detection stays RAW-only since signals are RAW-only.
2. Same change in `/api/portfolio/overview` for `marketPulseMap`. The `marketPulse` data shape will need a grade dimension.
3. Add a unit test: a fixture with one PSA 10 holding + one RAW holding asserts the PSA 10 value is the graded market price, not RAW.
4. Add a `holding.grade → bucket` normalizer in `lib/holdings/grade-normalize.ts`. Reuse the same logic as the script's `normalizeHoldingGrade` ([report-graded-pricing-coverage.mjs](../scripts/report-graded-pricing-coverage.mjs)).

**Risk:** Low — read-side change, no new writes.
- Adds at most one extra `.in('grade', ...)` filter to existing queries. Same indexed access pattern.
- The query still hits `public_card_metrics` which is small.

**Done when:**
- Unit test passes.
- Manual test: add a PSA 10 holding to a dev account, confirm portfolio value reflects the PSA 10 market price not the RAW.
- One week of staging traffic with no perf regression on `/api/holdings/summary` or `/api/portfolio/overview`.

**Rollback:** Revert the route changes; falls back to the current RAW-only behavior. The `holdings.grade` column stays untouched.

---

### Phase 3 — `/api/market/snapshot` + `/api/pro/signals` graded support

**Goal:** Allow callers to request graded data through the same routes that already serve RAW.

**Tasks:**
1. **`/api/market/snapshot`**: Already accepts `?grade=` and returns the metric for any grade ([market/snapshot/route.ts:60](../app/api/market/snapshot/route.ts)). The gap is at line 95 — it only fetches `public_price_history` and computes confidence band when `grade='RAW'`. Extend to handle graded:
   - Fetch graded history with the same `variant_ref ilike '%::PROVIDER::BUCKET%'` pattern iOS uses.
   - Compute the confidence band over graded points only — never mix.
   - Return the same response shape but filled in for graded.
2. **`/api/pro/signals`**: Currently hard-codes `eq("grade", "RAW")` ([pro/signals/route.ts:60](../app/api/pro/signals/route.ts)) AND `eq("provider", "JUSTTCG")`. Decision needed: do we want graded signals at all?
   - Per Phase 4 below, graded signals don't compute today (sparsity).
   - Recommended: accept a `?grade=` query param; if `grade!='RAW'` and signals are null for graded, return `{ ok: true, slug, variants: [], note: "Graded signals require ≥10 history points per variant, currently unavailable" }`. Don't 500 or 404 — explain the data gap.

**Risk:** Low.
- `/api/market/snapshot` change adds at most one extra query per non-RAW call. Already batched.
- `/api/pro/signals` change is purely a filter relaxation + an early-return. No new queries.

**Done when:**
- Both routes accept and respond correctly to `?grade=G10` against Tropical Beach BW28.
- iOS-parity-checker confirms APIClient decode for the optional graded fields.

**Rollback:** Revert; no DB state involved.

---

### Phase 4 — Graded signals (deferred — design work first)

**Goal:** Compute `signal_trend / signal_breakout / signal_value` for graded variants.

**Why deferred:** Today's calculator requires `history_points_30d >= 10` per (slug, variant_ref, provider, grade). Graded variants emit one snapshot per Scrydex refresh per provider × bucket × slug, which means a card has 1–2 history points per variant. The threshold can't simply be lowered — `cbfc0d5` and the broader signal-quality work assume 10 points to compute a meaningful trend slope. Bad signals are worse than no signals.

**Design options to evaluate (do not implement yet):**

A. **Aggregate across providers at the same bucket.** Combine PSA G10 + CGC G10 + BGS G10 + TAG G10 into one "Gem Mint 10" cohort with ≥10 points. Pros: solves sparsity. Cons: provider-quality differences (PSA 10 ≠ CGC 10 in market value) get blurred. Possibly OK if we present it as "Gem Mint cohort signal" not "PSA 10 signal."

B. **Lower the threshold for graded with a confidence flag.** Compute trend from 3–9 points and tag with `lowConfidence: true`. Pros: keeps provider granularity. Cons: signals will be noisy and could mislead. Need explicit UI that shows the "low confidence" flag.

C. **Compute slug-level graded signal instead of variant-level.** Aggregate all graded points for a slug (across providers and buckets) and emit one signal per (slug, "GRADED"). Pros: most history points. Cons: blurs all provider+bucket distinctions; possibly useful as a "graded heat" indicator on rails but less useful per-variant.

D. **Increase Scrydex refresh frequency for graded.** Pros: more data points over time. Cons: doubles ingestion load, exactly what the user said not to do.

**Risk if implemented:** Medium-to-high.
- Any new analytics writer touches `variant_metrics` writes at scale. Last time we did that (`097b6e0` "Silent DISTINCT ON rollup bug made refresh_card_metrics_for_variants no-op") it caused a silent stall.
- A new writer needs the same kid-gloves treatment as the RAW writer: small batches, durations logged, kill switch via cron schedule.

**Gate:** Don't start until product decides which option (A/B/C) to ship. Likely a separate plan doc.

---

### Phase 5 — Daily top movers + market signals (graded movers rail) — optional

**Goal:** A homepage rail that shows graded card movers (e.g., "PSA 10 movers today"), if Phase 4 ships.

Depends entirely on Phase 4. Skip unless the product team wants it. Mentioned here only for completeness.

---

## Cross-cutting safety controls

These apply to every phase:

1. **Run `npm run check:security:static` before any route commit.** This codebase has the route registry + guardrails config tightly enforced; any new route must be classified before merge.
2. **iOS parity check after every API change.** Use the `ios-parity-checker` agent or manually grep `ios/PopAlphaApp/APIClient.swift` for matching decode keys.
3. **DB monitoring via `/api/debug/pipeline-health`** before and after each phase. Watch `freshness.metricsAgeHours` and `pendingRollups` count.
4. **`pg_stat_statements` review one week after each phase** — query `select query, calls, total_exec_time from pg_stat_statements order by total_exec_time desc limit 20;` and confirm no new query is dominating.
5. **Kill switch**: every new code path should be gated by an env var or a database-driven feature flag so we can disable in seconds without a deploy. Use the existing GrowthBook flag pattern if appropriate.
6. **Phase-gating**: do not start phase N+1 until phase N has been live for ≥1 week without CPU regression. The pipeline has been re-tuned twice in the last 30 days due to CPU saturation; the budget for surprises is small.

## Verification — end-to-end

Once Phases 0–3 are shipped:

1. Spot-check 5 cards including Tropical Beach BW28, a high-volume Charizard, a low-pop modern card, a TAG-only graded card, and a card with no graded data. For each:
   - Web Grade Board renders chart + provider tiles + new market-summary panel.
   - iOS Grade Board same.
   - `/api/market/snapshot?slug=X&grade=G10` returns market_price + history confidence.
   - `/api/holdings/summary` correctly values a synthetic graded holding for that slug.
2. Re-run `report-graded-pricing-coverage.mjs` and confirm numbers match expectations + capture as a new dated report.
3. Run an `EXPLAIN ANALYZE` against the new `/api/market/graded-summary` route's primary query for both a small slug and a large slug; confirm it uses the `public_card_metrics` index on `(canonical_slug, grade)`.

## Files this plan touches

- New: [`scripts/report-graded-pricing-coverage.mjs`](../scripts/report-graded-pricing-coverage.mjs) (already exists).
- New: `app/api/market/graded-summary/route.ts` (Phase 1).
- New: `app/api/debug/graded-coverage/route.ts` (Phase 0).
- Modified: [`app/c/[slug]/page.tsx`](../app/c/[slug]/page.tsx) GRADED viewMode block (Phase 1).
- Modified: [`ios/PopAlphaApp/CardService.swift`](../ios/PopAlphaApp/CardService.swift) (Phase 1).
- Modified: [`ios/PopAlphaApp/CardDetailView.swift`](../ios/PopAlphaApp/CardDetailView.swift) (Phase 1).
- Modified: [`ios/PopAlphaApp/APIClient.swift`](../ios/PopAlphaApp/APIClient.swift) (Phase 1, decode keys).
- Modified: [`app/api/holdings/summary/route.ts`](../app/api/holdings/summary/route.ts) (Phase 2).
- Modified: [`app/api/portfolio/overview/route.ts`](../app/api/portfolio/overview/route.ts) (Phase 2).
- New: `lib/holdings/grade-normalize.ts` (Phase 2).
- Modified: [`app/api/market/snapshot/route.ts`](../app/api/market/snapshot/route.ts) (Phase 3).
- Modified: [`app/api/pro/signals/route.ts`](../app/api/pro/signals/route.ts) (Phase 3).
- Route registry + guardrails config updates for every new route.

## What changes structurally and what doesn't

**Stays the same:**
- RAW analytics writer ([`provider-observation-variant-metrics.ts`](../lib/backfill/provider-observation-variant-metrics.ts)) — still RAW-only, still skips graded.
- RAW chart view (`public_price_history_canonical`) — still excludes graded variant_refs.
- `price_history_points` table and its writers — already produce graded rows correctly.
- All ingestion paths — Scrydex graded extraction, snapshot rollups, card_metrics population.
- The `pipeline_jobs` queue — no new job kinds added.

**Changes:**
- New API surface for graded summary stats.
- New UI panels on web and iOS.
- API routes that previously hard-coded RAW now accept and respect graded grade parameters.
- Holdings valuation uses graded market price for graded holdings.

This is a **surfacing plan**, not an analytics-pipeline plan. The data is already there; the work is exposing it cleanly in the right places without bleeding into the RAW chart line.
