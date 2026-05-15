# Graded Pricing Coverage Report
_Generated 2026-05-05T05:45:34.482Z. Run via `node --env-file=.env.local scripts/report-graded-pricing-coverage.mjs`. Auto-generated; **for narrative findings + interpretation see [graded-surfacing-plan.md](graded-surfacing-plan.md) Phase 0**. This file is pure data._

_Historical snapshot note: provider names in this report reflect rows that existed on 2026-05-05. JustTCG rows are archived/legacy data; current English pricing ingestion is Scrydex-only._

## Headline

| Metric | Value |
|---|---:|
| Graded observations ingested (`provider_normalized_observations`) | 2,349,705 |
| Distinct provider-side cards with graded entries (50k sample, lower bound) | 9,380 |
| Distinct canonical cards with graded data in `card_metrics` | 15,422 |
| Distinct canonical cards with graded data in `variant_metrics` | 10,963 |
| Distinct canonical cards visible to users via `public_variant_metrics` | 10,963 |
| Graded variant rows with `history_points_30d > 0` (integer count) | 58,156 of 58,586 |
| Graded variant rows with non-null `signal_trend` (signals require ≥10 pts) | **0** of 58,586 |
| Graded variant rows with `provider_as_of_ts` in last 30d | 58,149 of 58,586 |
| Latest graded `provider_as_of_ts` (staleness signal) | 2026-04-15T02:45:35.974+00:00 (483h ago) |
| `card_metrics → variant_metrics` graded slug gap (intentional) | **4,459** slugs |

## Layer-by-layer

| Layer | Graded rows | RAW rows | Graded share |
|---|---:|---:|---:|
| 1. Observations (`provider_normalized_observations`, est. total ~3,775,141) | 2,349,705 | ~1,425,436 | 62.2% |
| 2. Snapshots (`price_snapshots`) | 110,828 | 54,947 | 66.9% |
| 3a. Slug-level metrics (`card_metrics`) | 124,983 | 54,601 | 69.6% |
| 3b. Variant metrics (`variant_metrics` — Grade Board source) | 58,586 | 50,054 | 53.9% |

Most recent graded snapshot `observed_at`: 2026-05-05T01:48:36.426+00:00.

## Snapshot rows by grade bucket

| RAW | LE_7 | G8 | G9 | G9_5 | G10 | G10_PERFECT |
|---:|---:|---:|---:|---:|---:|---:|
| 54,947 | 16,200 | 19,178 | 33,428 | 9,760 | 26,708 | 5,554 |

## card_metrics rows by grade bucket

| RAW | LE_7 | G8 | G9 | G9_5 | G10 | G10_PERFECT |
|---:|---:|---:|---:|---:|---:|---:|
| 54,601 | 19,137 | 23,798 | 30,451 | 14,333 | 27,189 | 10,075 |

## variant_metrics: provider × bucket (graded only)

| Provider | LE_7 | G8 | G9 | G9_5 | G10 | G10_PERFECT |
|---|---:|---:|---:|---:|---:|---:|
| **PSA** | 4,885 | 6,679 | 8,226 | 15 | 7,213 | 1 |
| **CGC** | 2,806 | 2,744 | 6,599 | 3,700 | 5,876 | 2,878 |
| **BGS** | 360 | 421 | 1,905 | 1,432 | 308 | 134 |
| **TAG** | 287 | 212 | 986 | 2 | 906 | 11 |

## Observation provenance by grading provider

| Provider | Graded observations |
|---|---:|
| PSA | 1,070,491 |
| CGC | 991,505 |
| BGS | 191,508 |
| TAG | 96,201 |

## Drop-off

The meaningful drop-off is between `card_metrics` (slug-level rollup) and `variant_metrics` (variant-level, what the Grade Board reads):

- Distinct canonical slugs with graded data in `card_metrics`: **15,422**
- Distinct canonical slugs with graded data in `variant_metrics`: **10,963**
- Slugs with graded `card_metrics` rows that **never reach** `variant_metrics`: **4,459** (intentional — `provider-observation-variant-metrics.ts` hard-rejects graded; the existing variant_metrics graded rows are stale from a one-time 2026-04-15 batch)

(The `price_snapshots` 50k-row sample is biased toward the freshest 45% of graded snapshots and is **not** comparable to the full `variant_metrics` slug set; reported below for reference only.)

- Distinct canonical slugs in the price_snapshots 50k sample: 8,069 (sample, lower bound)
- Distinct canonical slugs in `public_variant_metrics`: 10,963

## PSA cert pipeline (separate from Scrydex)

| Metric | Value |
|---|---:|
| `psa_certificates` rows (estimated) | 0 |
| `variant_metrics` rows with `provider='PSA'` | 27,019 |

The PSA cert path is dual-gated: (1) PSA grade string must parse via `gradeBucketFromPsaGrade` ([app/api/ingest/psa/route.ts:52](../app/api/ingest/psa/route.ts)) and (2) the cert must resolve to a canonical `(slug, printing_id)` via `resolvePsaPrinting`. Certs that fail either gate stay in `psa_certificates.raw_payload` and never reach `variant_metrics`. Implied gate-survival rate: **—** (note: a single canonical printing can absorb many certs, so this is a lower bound on PSA's contribution rather than a literal cert→variant ratio).

## Holdings mis-valuation (concrete user impact)

| Metric | Value |
|---|---:|
| User holdings with graded grade | 0 |
| User holdings with RAW grade (NM/LP/MP/HP/DMG/RAW) | 4 |
| User holdings with NULL grade | 0 |

[`/api/holdings/summary`](../app/api/holdings/summary/route.ts) hard-codes `eq("grade", "RAW")` at lines 97 and 106, so every graded holding above is **valued at the RAW market price** in the iOS portfolio. Sample of up to 10 distinct (slug, grade) graded holdings:

| Slug | Holding grade | Qty | RAW market (what user sees) | Graded market (what they should see) | Δ | Provider |
|---|---|---:|---:|---:|---:|---|
_No graded holdings found in the sample._

## Surfacing matrix

| Surface | File:line | Renders graded? | Notes |
|---|---|---|---|
| Web Grade Board (card detail page) | [app/c/\[slug\]/page.tsx:1143](../app/c/[slug]/page.tsx) | ✓ chart + tiles | Reads `public_variant_metrics` + `public_price_history` directly via PostgREST; provider toggle (PSA/BGS/CGC) + grade picker render with real prices. Reference price (`selectedGradedReference`) comes from `gradeSnapMap[grade].median_7d`; provider tiles come from latest `public_price_history` row per variant_ref |
| iOS Grade Board | [ios/PopAlphaApp/CardDetailView.swift:67](../ios/PopAlphaApp/CardDetailView.swift) | ✓ chart + tiles | Calls `fetchGradedVariantMetrics` ([CardService.swift:169](../ios/PopAlphaApp/CardService.swift)) for variant list, `fetchGradedPriceHistory` ([CardService.swift:149](../ios/PopAlphaApp/CardService.swift)) for the chart (variant_ref ilike pattern). `history_points_30d` (integer) is used as a sufficiency gate, not chart data |
| `/api/market/snapshot` | [route.ts:60,95](../app/api/market/snapshot/route.ts) | partial | Accepts `?grade=` and returns metric `market_price`; price-history confidence band only fires when `grade='RAW'` |
| `/api/pro/signals` | [route.ts:60](../app/api/pro/signals/route.ts) | ✗ | Hard-coded `eq("grade", "RAW")` — pro users see no graded signals |
| `/api/holdings/summary` | [route.ts:97,106](../app/api/holdings/summary/route.ts) | ✗ | Hard-coded `eq("grade", "RAW")` for both market_price and hot-mover lookup; graded holdings mis-valued |
| `/api/portfolio/overview` | [route.ts:190-212](../app/api/portfolio/overview/route.ts) | counts only | Counts graded vs raw holdings; `totalValue` derives from `marketPulseMap` which is RAW-only by construction |
| `/api/personalization/explanation` | [route.ts:120](../app/api/personalization/explanation/route.ts) | flag only | Adds `is_graded` boolean for explanation copy |
| Daily top movers rail | [compute-daily-top-movers/route.ts](../app/api/cron/compute-daily-top-movers/route.ts) | ✗ | RPC `compute_daily_top_movers` has no `grade` parameter — RAW-only by construction |
| Market signals | [market-signals/route.ts](../app/api/market-signals/route.ts) | ✗ | No grade dimension |
| Analytics variant_metrics writer | commit `33cc91b` | ✗ | Skips graded observations entirely |
| RAW price history view | commit `cbefdec` | ✗ | Excludes `GRADED::` variant_refs |

## Spot-check

Looked up `bw-black-star-promos-bw28-tropical-beach` (Tropical Beach). `public_variant_metrics` rows: **8** (providers: CGC, PSA, SCRYDEX, JUSTTCG, TAG; grades: LE_7, G9, G8, RAW).

---

For narrative interpretation, open questions, and methodology caveats, see [graded-surfacing-plan.md](graded-surfacing-plan.md) Phase 0. For at-a-glance live coverage numbers without running this 7-min script, use `GET /api/debug/graded-coverage` (cron-secret authed, runs in ~2s).
