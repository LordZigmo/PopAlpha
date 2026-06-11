# PopAlpha Roadmap

> **This is the standing roadmap.** Every working session should read this
> first and update it when scope ships, changes, or gets cut. Keep entries
> short — link to a playbook/handoff doc for depth. Status values:
> `shipped` / `in progress` / `next` / `backlog` / `evaluating`.

_Last updated: 2026-06-11_

## Now: v1.0 App Store launch

- **Submission build** — `in progress`. Web + pipeline launch-hardening done
  (PRs #217–#220). iOS launch features merged (#220): direct StoreKit review
  ask, Request a Feature → PostHog, premium lock frost redesign, PopAlpha
  Summary rename, free-budget banner, $12.99/mo + $89.99/yr pricing.
  Remaining: design-feedback branch PR (graded ladder chart, chart range
  bounds, Collector Insight glass reskin, light-mode glass fix, PSA pop
  pipeline), screenshots, final QA, submit.
- **Post-launch watch** — PostHog launch dashboard + alert; cron-failure
  alerting (Scrydex raw-liveness, PriceCharting freshness, FX health).
  Note: drop PostHog tiles referencing removed events `review_gate_shown`,
  `review_gate_answered`, `feedback_submitted` (replaced by
  `review_prompt_requested`).

## Feature: Population Tables (building out)

**Goal:** Collector-grade population data per card — current grade
distribution AND population over time — as a Pro differentiator.
**Why now:** pop history cannot be backfilled from any grader; the industry
(GemRate → Card Ladder/Collectr) builds it by snapshotting daily and
diffing. Every day our snapshot cron runs is moat accrued.

| Phase | Status | Notes |
| --- | --- | --- |
| 1. Snapshot pipeline (PSA official API) | `shipped` (pending merge + migration apply) | `psa_spec_targets` rotation + `psa_spec_pop_snapshots` daily rows via `GET /publicapi/pop/GetPSASpecPopulation/{specID}`; cron `snapshot-psa-pop` 07:50 UTC, 60-call budget (PSA free tier ~100/day shared with cert lookups). SpecIDs harvested from every slab scan + seeded from historic cert lookups. |
| 2. SpecID → catalog mapping | `next` | Handoff: `docs/psa-specid-mapping-handoff.md`. Fills `psa_spec_targets.canonical_slug` so pop data can key by card slug. |
| 3. Scan-result pop panel (first surface) | `backlog` (v1.1 headliner) | Full grade distribution + gem rate on the slab-scan result — 100% coverage from day one (every scan carries SpecID); +1 API call per scan, snapshot table as same-day cache. |
| 4. Card-detail POP tab | `backlog` | Needs phase 2 coverage + a few weeks of history for the over-time chart. Read model: latest-snapshot view + captured_on diffs. Reuse `MultiLineChartView`. |
| 5. Breadth: GemRate / CGC / TAG | `evaluating` | GemRate Partner API = 4 graders + multi-year history backfill (demo-gated pricing, likely $$$/mo). TAG is uncovered by GemRate and openness-friendly — direct outreach could be a differentiator. Research record: session 2026-06-11. |

## Feature: Japan localization (v1.1 fast-follow)

- `backlog` — deliberately NOT at launch. Full plan from 2026-06-10 session:
  App Store ja-JP listing, iOS string localization, JP-first card surfaces
  (JP pricing already in data layer), pricing tier check. Apple small
  business program (15%) applies; no Japan business registration needed —
  Apple is merchant of record and handles JCT.

## Pipeline / data robustness

- **Scrydex starvation class** — `shipped`: volume-derived stage budgets
  (`calculateScrydexStageObservationBudget`), queued-preset ceilings raised
  to match, raw-liveness alarm cron. Postmortem lives in the code comments
  (`provider-pipeline-batch-config.ts`).
- **Scrydex test file** — `backlog`: `tests/scrydex-price-history.test.mjs`
  is not wired into CI and carries pre-existing drift
  (`resolveScrydexDailyRequestBudget` 347 vs expected 330). Fix the drift,
  wire into CI.
- **Prune starvation / DB size** — `shipped` (2026-06-11): root cause was
  worse than starvation — every prune_old_data() since 20260413 filtered
  provider_ingests on a column that never existed (created_at vs
  ingested_at), so any call reaching that section threw 42703 and rolled
  back the ENTIRE nightly prune; payload SET NULL fan-out (~119 indexed
  obs updates per payload row) compounded it once backlogs grew. Fixed
  across 20260611231500 (time-budgeted looping prune) and 20260612003000
  (observations-first order, ingested_at fix, payload gate,
  price_snapshots.ingest_id index). Backlog drained 2026-06-11 on a
  temporary XL compute bump: 9.40M observations, 1.00M ingest_runs,
  60.9k payloads (+ ~7.8M provider_observation_matches via FK cascade —
  matches needs no retention policy of its own). VACUUM FULL + REINDEX
  reclaim: **DB 71 GB -> 33 GB**; observations 32 GB -> 5.2 GB,
  payloads 5.9 -> 1.0 GB, ingest_runs 4.4 -> 1.8 GB,
  price_history_points 10 -> 5.3 GB. Nightly cron now runs ?loops=100:
  measured inflow is ~430k obs/day, so the old loops=10 default
  (100k/night cap) would have silently re-starved. Verify the nightly
  prune log shows budget_exhausted=false and small per-table numbers;
  if provider_observation_matches bloat matters later, VACUUM FULL it
  (~5 GB reclaimable, was left in place 2026-06-11). Supabase
  provisioned disk does NOT auto-shrink — reduce in Dashboard ->
  Database -> Disk after confirming steady state.
- **Scrydex credit-burn telemetry** — `backlog`: surface daily credit
  consumption vs the 50k/month budget so drains/catchups can't surprise us.
- **Drain counter semantics** — `backlog`: `write-provider-timeseries`
  response counters conflate processed/written; clarify.

## iOS polish backlog

- Homepage `AIBriefCard` "AI BRIEF" eyebrow rename — awaiting name decision
  ("MARKET BRIEF" / "POPALPHA BRIEF"); card-detail header already renamed to
  POPALPHA SUMMARY.
- Bucket C Tier 3 robustness items (from 2026-06-09 audit) — low-priority
  hardening, see session notes.

## Decision log (abridged)

- 2026-06-11: Review gate removed in favor of direct `requestReview()` on
  3rd cold launch (App Review 5.6.1 risk eliminated). Feedback channel =
  Profile → Request a Feature.
- 2026-06-11: Graded chart = always the blended grade ladder (loot-rarity
  colors: red 10P / gold 10 / purple 9.5 / blue 9 / green 8 / gray ≤7);
  grade wheel removed, pills select grade for price/metrics.
- 2026-06-10: Pricing locked at $12.99/mo + $89.99/yr (CardLadder anchor
  $200/yr). De-AI of user-facing value props is standing direction.
