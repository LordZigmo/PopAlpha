# Ingestion Pipeline Playbook

**Audience:** Future Claude (or any engineer) debugging, tuning, or extending the Scrydex ingestion pipeline.

**Last updated:** 2026-04-16 after a compound day: LIKE-OR fallback burning 70% of DB CPU, two cascade failures it had been masking, and a silent structural bug in `refresh_card_metrics_for_variants` that had been aborting every call since 2026-04-07 and was the real cause of user-visible stale prices.

---

## The goal (read this first — everything else follows from it)

> **Keep 24-hour price freshness high for as many cards as possible, while minimizing Scrydex credit burn and Supabase resource utilization.**

Three hard constraints, ranked by priority:

1. **Freshness** — `fresh_cards_24h / addressable_catalog` should stay ≥ 95%. `addressable_catalog` is `COUNT(*) FROM public_card_metrics WHERE grade='RAW' AND printing_id IS NULL AND market_price IS NOT NULL` (currently ~18,600). The total canonical count (~19,570) is **not** the right denominator — 1,000+ cards have no market price at all and can never be "fresh".
2. **Scrydex credits** — the only upstream cost. Price history calls are 3 credits/card; daily request budget fallback is 120/day with 1.15× headroom. Every optimization must be credit-neutral or credit-negative. Never increase call volume to fix a perf issue.
3. **Supabase compute + disk IO** — these get exhausted by runaway pipelines. On medium compute, **CPU is the first constraint** (not disk IO). The `price_history_points` table is the #1 CPU consumer — its SELECT and DELETE queries must include `ts` bounds to avoid full-table scans. Disk IO burst budget is the second thing to burn.

When in doubt: **correctness > freshness > credit thrift > DB load > latency**. Never sacrifice a higher-priority item for a lower one.

---

## Pipeline architecture in one page

```
Vercel cron (every 6h)              Vercel cron (every 3m)           Vercel cron (twice hourly)
  run-scrydex-daily/[1-4]     →      process-provider-pipeline-jobs    batch-refresh-pipeline-rollups
  enqueue jobs per set               claim + execute N jobs parallel    drain pending_rollups
         │                                    │                                    │
         ▼                                    ▼                                    ▼
   pipeline_jobs  ─── claim ───▶  runProviderPipeline (SCRYDEX)                 5 refresh RPCs
   (QUEUED)                            │                                     (card metrics,
                                       ├─ ingest  (Scrydex API)                price changes,
                                       │   ↓                                   market confidence,
                                       │   provider_raw_payloads                canonical parity,
                                       ├─ normalize                             set summaries)
                                       │   ↓                                         │
                                       │   provider_normalized_observations          ▼
                                       ├─ match                                 public_card_metrics
                                       │   ↓                                    (market_price_as_of)
                                       │   provider_observation_matches
                                       ├─ timeseries
                                       │   ↓
                                       │   price_snapshots  ◀── rollup reads from here
                                       ├─ variant_metrics
                                       └─ enqueue touchedVariantKeys → pending_rollups
```

### Key design decisions

- **Job queue is two-part**: cron producers (`run-scrydex-daily/[chunk]`) enqueue rows into `pipeline_jobs`, a separate cron (`process-provider-pipeline-jobs`) claims and executes them in parallel. **Never merge these.** The separation is what lets you throttle each side independently.
- **Rollups are deferred, not inline.** Every pipeline job used to run 5 refresh RPCs inline, adding 60–120 s to every job. We moved that work into a `pending_rollups` queue that a separate hourly(ish) batch cron drains. This is the single biggest throughput win in the whole system.
- **Scan queries go through RPC functions, not the Supabase JS client.** PostgREST generates `.order().range()` query patterns that caused "non-integer constant in ORDER BY" errors on certain tables. The fix is SQL functions (`scan_normalized_observations`, `scan_matched_observations`, `scan_card_printings_by_set`, `scan_card_printings_for_priority`, `scan_variant_price_latest_for_priority`) called via `.rpc()`. Don't reintroduce `.order().range()` on match-path tables unless you've tested thoroughly.
- **setLimit stays at 1.** Bundling sets per job makes jobs heavier and more timeout-prone without meaningful throughput gains now that rollups are deferred.
- **Processor is parallel inside a single invocation.** `Promise.allSettled` runs up to 4 claimed jobs concurrently. Sequential claim → parallel execute avoids `claim_pipeline_job` lock contention.

### Cron schedule (source of truth: `vercel.json`)

| Cron | Schedule | Purpose |
|------|----------|---------|
| `run-scrydex-daily/1..4` | Every 6h (00:05, 06:20, 12:35, 18:50 UTC) | Enqueue pipeline jobs, priority-sorted |
| `run-scrydex-2024plus-catchup` | Every 12h (:20) | Catch-up for 2024+ sets, capped at 300 credits |
| `process-provider-pipeline-jobs` | Every 3m | Claim + execute up to 4 jobs in parallel |
| `batch-refresh-pipeline-rollups` | Twice hourly (:22, :52) | Drain `pending_rollups` through 5 refresh RPCs |
| `refresh-card-metrics` | Every 12h (:15) | Backstop full sweep in case targeted refresh misses anything |
| `snapshot-price-history` | Every 6h (:50) | Full pricing snapshot via `snapshot_price_history()` |
| `refresh-set-summaries` | Daily 09:00 UTC | 4 heavy set-level refreshes |
| `refresh-derived-signals` | Daily 08:00 UTC | Variant signal reconcile |
| `prune-old-data` | Daily 03:40 UTC | 90-day hard delete + 30-day downsample of price_history_points |
| `downsample-price-history` | Daily 04:15 UTC | Backlog cleanup: downsample 7 days of old data per run (temporary) |
| `refresh-card-profiles` | Every 6h (:10) + daily 10:45 UTC | AI summary backfill (500 cards/run) + daily refresh |
| `refresh-ai-brief` | Hourly (:23) | Homepage market narrative (Gemini) |
| `refresh-card-embeddings` | Daily 09:30 UTC | Semantic search embeddings |
| Various | Various | FX rates, PSA, transparency audits |

### Batch configuration (source of truth: `lib/backfill/provider-pipeline-batch-config.ts`)

SCRYDEX preset, from our tuning:

```ts
PIPELINE:  { setLimit: 1, maxRequests: 10, payloadLimit: 10, matchObservations: 100, timeseriesObservations: 100, metricsObservations: 100 }
RETRY:     { setLimit: 1, maxRequests: 1,  payloadLimit: 8,  matchObservations: 80,  timeseriesObservations: 80,  metricsObservations: 80  }
MINIMAL:   { setLimit: 1, maxRequests: 3,  payloadLimit: 4,  matchObservations: 40,  timeseriesObservations: 40,  metricsObservations: 40  }
```

These were reduced from 500 observations previously. **Do not raise without a specific reason** — they were the reason disk IO got burned.

---

## The incidents and how they were fixed

These are the 10 distinct root causes we found, in the order they became blocking. Each one is paired with its verification query and fix so future Claude can re-diagnose quickly.

### 1. `'SCRYDEX'` string literal in `ORDER BY` of `refresh_card_metrics_for_variants`

**Symptom:** 87% job failure rate with `non-integer constant in ORDER BY` error surfacing in `targeted_rollups` step of `last_result->steps`. Every job completed ingest/normalize/match/timeseries/variant_metrics but failed at the very last rollup step.

**Root cause:** Migration `20260407000000_remove_justtcg_from_scoped_refresh.sql` replaced a `ps.provider` column reference with the literal string `'SCRYDEX'` inside an `ORDER BY` clause when removing JustTCG. PostgreSQL rejects `ORDER BY <string_constant>`.

**Diagnostic query:**
```sql
SELECT step->>'name' as name, step->>'ok' as ok
FROM pipeline_jobs, jsonb_array_elements(last_result->'steps') as step
WHERE id = <failed_job_id>;
```

**Fix:** Recreate the function with `ps.provider` restored:
```sql
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'refresh_card_metrics_for_variants';
  v_src := replace(v_src, E'      ''SCRYDEX'',\n      ps.provider_ref,', E'      ps.provider,\n      ps.provider_ref,');
  EXECUTE format('CREATE OR REPLACE FUNCTION public.refresh_card_metrics_for_variants(keys jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = ''0'' SET lock_timeout = ''0'' SET search_path = public AS $fn$%s$fn$', v_src);
END;
$$;
```

Permanent fix committed in migration `20260409140000_fix_scrydex_literal_in_order_by.sql`.

**Lesson:** When migrations remove providers from multi-provider functions, audit every `ORDER BY` for string literals.

### 2. Missing composite index on match scan

**Symptom:** `provider_observation_matches(scan): canceling statement due to statement timeout` errors under load. Match stage takes 30+ seconds even on small batches.

**Root cause:** The match scan on `provider_normalized_observations` orders by `(observed_at DESC, id DESC)` but the existing index was only `(provider, observed_at DESC)`. Missing `id` means Postgres must re-sort rows with identical timestamps.

**Fix:** Migration `20260409100000_fix_match_scan_index.sql`:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_normalized_observations_provider_observed_id_idx
  ON public.provider_normalized_observations (provider, observed_at DESC, id DESC);
```

**Verification:**
```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'provider_normalized_observations'
  AND indexname = 'provider_normalized_observations_provider_observed_id_idx';
```

### 3. Missing partial composite index on timeseries scan

**Symptom:** Same as #2 but on `provider_observation_matches`.

**Fix:** Migration `20260409110000_fix_timeseries_scan_index.sql`:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_observation_matches_provider_status_set_idx
  ON public.provider_observation_matches (provider, match_status, provider_set_id, updated_at DESC)
  WHERE match_status = 'MATCHED';
```

The partial `WHERE` clause is important — both timeseries and variant-metrics stages exclusively query `match_status='MATCHED'`, so a partial index is ~30% smaller.

### 4. PostgREST `.order().range()` bug: "non-integer constant in ORDER BY"

**Symptom:** Failures in `last_error` matching `non-integer constant in ORDER BY` — but **only for some queries**, not others. Raw SQL works, PostgREST fails.

**Root cause:** A specific interaction between PostgREST's query generation and certain `.order().range()` combinations. Reproduces reliably for some tables and not others. We never fully isolated which server version introduced it, but the workaround is bulletproof.

**Fix:** Convert paginated scan queries to SQL functions called via `.rpc()`. Migrations `20260409120000_scan_rpc_functions.sql` and `20260409130000_pipeline_scan_rpcs.sql` define:
- `scan_normalized_observations`
- `scan_matched_observations`
- `scan_card_printings_by_set`
- `scan_card_printings_for_priority`
- `scan_variant_price_latest_for_priority`

All call sites in `lib/backfill/` now use `.rpc("scan_*", {...})`. **If you add a new paginated scan on a match-path table, use this pattern.**

### 5. `CASE WHEN` in ORDER BY evaluates to NULL constant (my own bug)

**Symptom:** After shipping the RPC fix in #4, the same "non-integer constant in ORDER BY" error reappeared from the RPC functions themselves.

**Root cause:** The first cut of `scan_normalized_observations` tried to handle ASC/DESC via:
```sql
ORDER BY
  CASE WHEN p_ascending THEN o.observed_at END ASC,
  CASE WHEN p_ascending THEN o.id END ASC,
  CASE WHEN NOT p_ascending THEN o.observed_at END DESC,
  CASE WHEN NOT p_ascending THEN o.id END DESC
```
When `p_ascending = false`, the first two CASE expressions collapse to `NULL` — which is a constant, which triggers the error.

**Fix:** Migration `20260409120000` rewrites the function in plpgsql with `IF/ELSE` and two separate `RETURN QUERY` statements. **Never put a CASE expression in ORDER BY if one branch can collapse to a constant.**

### 6. Inline rollups bottleneck (the big throughput fix)

**Symptom:** Pipeline jobs taking ~250 seconds each, max ~10 jobs/hour, full catalog refresh would take ~60 hours.

**Root cause:** Every pipeline job ran `refreshPipelineRollupsForVariantKeys` inline as its final step, which sequentially called 5 refresh RPCs on that job's touched variants. The 5 RPCs each take 10–30 s and do redundant work (multiple jobs touching the same card re-ran the same rollup).

**Fix:** Deferred rollup architecture. Migration `20260410000000_pending_rollups.sql` introduces:
- `pending_rollups` table with PK `(canonical_slug, variant_ref, provider, grade)` — natural dedup via `INSERT ... ON CONFLICT DO NOTHING`
- `claim_pending_rollups(p_limit)` SQL function — atomic `FOR UPDATE SKIP LOCKED + DELETE ... RETURNING` so concurrent claims never race
- `lib/backfill/provider-pipeline-rollup-queue.ts` with `queuePendingRollups` and `claimAndDeletePendingRollups` helpers
- `app/api/cron/batch-refresh-pipeline-rollups/route.ts` drains the queue twice hourly
- Orchestrator stage `targeted_rollups` now just enqueues keys instead of running the rollup inline

Jobs dropped from ~250 s to ~6–8 s. Throughput jumped from ~10 jobs/h to 200+ jobs/h.

**Caveats of the deferred design:**
- `market_price_as_of` (and the five rollup-dependent stats: price changes, market confidence, canonical parity, set summaries, card metrics) lag real time by up to ~30 minutes under nominal load and up to ~1 hour under heavy load. User explicitly accepted 1-hour staleness.
- If the batch cron fails, `pending_rollups` grows. The `refresh-card-metrics` every-6h backstop cron catches drift.

### 7. `statement_timeout = '30s'` inside scan RPCs cascaded to 480s pipeline timeouts

**Symptom:** After the deferred-rollup fix, most jobs ran in 7 s but ~16 per 12h window timed out at exactly 480s.

**Root cause:** The first version of the scan RPCs had a defensive `SET statement_timeout = '30s'` on them. On large sets, the indexed OFFSET scan legitimately exceeded 30s. When it threw, the pipeline's drain loop interpreted "stage failed" as "retry the stage", doing up to 8 passes × ~60 s each = exactly 480 s before the outer job timeout killed it.

**Fix:** Migration `20260410100000_relax_scan_rpc_timeouts.sql` recreates both scan RPCs without `SET statement_timeout`. The outer `PIPELINE_JOB_TIMEOUT_MS` (480 s) is the only authoritative runtime cap.

**Lesson:** Inner timeouts < outer timeouts + drain-loop retries is a cascading-failure foot-gun. Let the outermost layer own the deadline.

### 8. Batch rollup cron — 2000-key batches too heavy under disk IO throttling

**Symptom:** Batch cron returning 500 with no logs. `metrics_newest` stuck 7+ hours behind `snapshots_newest` even though `pending_rollups` was growing then visibly processing.

**Root cause:** Under Supabase disk IO throttling, each 2000-key batch was taking longer than the 300 s function budget. Zero rollups delivered per invocation because the first batch never completed.

**Fix journey:**
1. Shrink batch to 200 → still timing out (600s)
2. Shrink to 50 → works within 300s cap but tight
3. User raised Vercel Function Max Duration from 300 → 600 at project level
4. Final code: `DEFAULT_BATCH_SIZE = 50`, `maxDuration = 600`, `DEADLINE_RESERVE_MS = 90_000`, schedule `10,40 * * * *`

At ~50 s per 50-key batch, a 600 s budget with 90 s reserve = ~10 batches = 500 keys per run. Twice-hourly schedule = 1,000 keys/h drain capacity against ~280 keys/h intake. Plenty of margin.

**Critical rule:** The Vercel project-level **Function Max Duration** (Settings → Functions) silently overrides per-file `maxDuration` exports. Check that first when a cron times out at a round number.

### 9. Disk IO budget exhaustion (not our fault but our problem)

**Symptom:** Supabase dashboard banner "This project is depleting its Disk IO budget." CPU ~72% healthy, memory ~57% healthy, disk IO at baseline 1% (throttled).

**Root cause:** Two days of runaway failed pipeline runs with 480s timeouts burned through the burst budget. The budget refills when usage is below baseline but only gradually.

**Fix:** Don't fight it. Reduce ongoing load so the budget refills naturally:
- Deferred rollups (#6) — biggest reduction in per-job DB writes
- Removed JustTCG cron entries (retired ingestion that was still firing)
- Daily sweep chunks 8 → 4
- `process-provider-pipeline-jobs` every 2 min → 3 min
- Scan RPCs without inner timeout (#7) stopped the retry cascade

**Mental model:** Disk IO budget is like a credit card limit, not a meter. Burn it and you're capped at baseline for hours. The only recovery is to run below baseline for a while.

### 10. Homepage rendering empty because `DATA_TIMEOUT_MS = 8000` was too aggressive under throttled IO

**Symptom:** `popalpha.ai` homepage shows layout but all card rails are empty and "PRICES refreshed" shows "--". Database has 5,011+ movers candidates and 18,630+ refreshed cards. Problem is frontend, not data.

**Root cause:** `app/page.tsx` had:
- `export const dynamic = "force-dynamic"` — every visitor triggers a full fresh 5-query batch
- `DATA_TIMEOUT_MS = 8000` — if queries don't finish in 8 s, fall back to `EMPTY_DATA`

Under disk IO throttling, `public_card_metrics` queries took 10–20 s. Timeout fired every time. Every visitor saw empty arrays.

**Fix:**
```ts
export const revalidate = 60;              // ISR: cache result for 60s
const DATA_TIMEOUT_MS = 30_000;             // 30s budget for the one query per minute
```

One visitor per 60-second window per edge region pays the cost; everyone else gets cached HTML instantly. Commit `a91e3f1`.

**Lesson:** `force-dynamic` on a homepage is asking for a thundering herd when the DB is slow. Prefer ISR with a short revalidate window for "live" pages that read aggregates.

### 11. `price_history_points` table growth → CPU saturation (the table size incident)

**Symptom:** CPU at 99% on Supabase medium compute. Pipeline jobs timing out at 480s. Freshness dropping from 36% to 32%. `pg_stat_statements` showed two query patterns on `price_history_points` consuming 113 hours of CPU per day (SELECT: 120s avg × 1,789 calls, DELETE: 120s avg × 1,585 calls).

**Root cause:** The table grew to 13M rows / 8.3 GB (plus 6.2 GB of indexes). The stale variant DELETE queries in `provider-observation-timeseries.ts` (lines 539-617) scanned the entire table because they had no `ts` bound — only filtering by `provider` and `variant_ref`. Every pipeline job ran these queries, and at 120s each they consumed all available CPU.

**Diagnostic queries:**
```sql
-- Top CPU consumers
SELECT substring(query from 1 for 120) as q, calls,
  round(total_exec_time::numeric / 1000) as total_sec,
  round(mean_exec_time::numeric) as avg_ms
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5;

-- Table size
SELECT pg_size_pretty(pg_total_relation_size('price_history_points')) as size,
  count(*) as rows FROM price_history_points;

-- Data age distribution
SELECT CASE
    WHEN ts >= now() - interval '7 days' THEN '0-7d'
    WHEN ts >= now() - interval '30 days' THEN '8-30d'
    WHEN ts >= now() - interval '90 days' THEN '31-90d'
    ELSE '90+d'
  END as bucket, count(*) FROM price_history_points GROUP BY 1 ORDER BY 1;
```

**Fix (three parts):**

1. **Downsample old data** — `downsample_price_history_points_batch()` SQL function keeps 1 point per (card, variant, provider, source_window) per day for data older than 30 days. Called by `prune_old_data()` step 7b (daily) and `downsample-price-history` cron (backlog cleanup). Migration: `20260416000000_downsample_price_history.sql`.

2. **Add `ts` bounds to stale variant DELETEs** — All DELETE and SELECT queries on `price_history_points` in `provider-observation-timeseries.ts` now include `.gte("ts", ninetyDaysAgo)`. This lets Postgres use composite indexes and skip 90%+ of the table.

3. **Drop unused indexes** — `price_history_points_snapshot_day_slug_idx` (61 MB, 0 scans) and `price_history_points_dedup_idx` (16 MB, 0 scans) were dead weight.

**Expected outcome:** 13M → ~3-4M rows, 8.3 GB → ~2.5-3 GB, CPU from 99% to ~40%.

**Lesson:** `price_history_points` is the highest-churn table in the system. Any query on it without a `ts` bound is a full-table scan bomb. Always include `ts >= <cutoff>` in WHERE clauses. Monitor table size monthly — if it grows beyond 5M rows, investigate why downsampling isn't keeping up.

### 12. `variant_metrics` check constraint rejecting G9_5/G10_PERFECT grades

**Symptom:** 48 pipeline job failures with `variant_metrics(upsert): violates check constraint "variant_metrics_printing_key_variant_ref_chk"`.

**Root cause:** The check constraint in `20260301200000_variant_ref_identity_standardization.sql` only allowed grades `LE_7, G8, G9, G10` but not `G9_5` or `G10_PERFECT`, which were added later in the grade vocabulary expansion (`20260411140000_grade_vocabulary_v2.sql`). The constraint was never updated to match.

**Fix:** Migration `20260416000000_downsample_price_history.sql` step 4 updates the constraint to allow G9_5, G9_5, G10_PERFECT, 9_5, and 10_PERFECT.

### 13. Increasing cron concurrency/batch sizes without monitoring CPU (don't do this)

**Symptom:** After bumping from 4 → 8 daily chunks, 4 → 6 job concurrency, and 100 → 200 observations per batch, CPU went to 99% and jobs started zombieing. Freshness dropped from 36% to 32%.

**Root cause:** More concurrent work = more concurrent DB queries = more CPU. On medium compute, the CPU was already near capacity. Doubling the load pushed it over the edge. Jobs took so long they exceeded the 480s timeout and got stuck in RUNNING status, blocking the queue.

**Fix:** Reverted to 4 chunks, 4 concurrency, 100 observations. **Do not increase these without first reducing the table size** (via downsampling) to bring baseline CPU usage under 60%.

**Lesson:** Before increasing pipeline throughput, always check CPU first:
```sql
-- What's running right now
SELECT state, substring(query from 1 for 100),
  round(extract(epoch from now() - query_start)) as sec
FROM pg_stat_activity WHERE state != 'idle' AND pid != pg_backend_pid();
```
If you see queries running for 30+ seconds, the DB is already stressed. Increasing load will make it worse.

### 14. LIKE-OR fallback + masked cascades + silent `DISTINCT ON` structural bug (2026-04-16)

**Symptom (what the operator saw):** Supabase at 100% CPU and 100% Disk IO for most of the day. User reported "only ~7k cards have fresh market prices." Catalog coverage was actually fine (19,431 / 19,568 priced = 99.3%), but `fresh_24h` was stuck at 9,820 and `MAX(market_price_as_of)` for RAW+no-printing hadn't advanced past 20:57 UTC even after manually running a 143k-row `refresh_card_metrics` sweep. Scrydex was feeding us 22,320 fresh observations per hour, so the data was arriving — it just wasn't landing in `public_card_metrics`.

This was one reported symptom, three independent problems. The LIKE-OR fallback was burning the CPU. Gating it exposed two cascade failures that had been hidden by the timeout budget it consumed. Separately, a migration from 2026-04-07 had been silently aborting the primary rollup RPC for nine days, and none of the other fixes mattered until that was patched.

---

#### 14a. LIKE-OR fallback on `price_history_points` (the CPU fire)

**Root cause:** `cleanupStaleProviderVariantWrites` in [lib/backfill/provider-observation-timeseries.ts:571-621](../lib/backfill/provider-observation-timeseries.ts) has a two-path design. Happy path: resolve stale variants to exact `provider_ref` values and delete by those. Fallback path: if some variants don't resolve, build a WHERE clause of `variant_ref LIKE 'x::%' OR variant_ref LIKE 'y::%' OR ...` and issue one big DELETE. The fallback fires frequently because non-resolving variants are common (matches not yet in `provider_observation_matches`).

The fallback query consumed 70% of `pg_stat_statements.total_exec_time` — mean 80–120 s × ~10k calls/day. Even though `'x::%'` has no leading wildcard on its own, OR-chaining many LIKE predicates makes the planner bail on index use and sequential-scan all 90 days of `price_history_points` (13M rows, 8.3 GB). This is the same class of full-table scan that incident #11 addressed, just wearing a different costume.

**Diagnostic query:**
```sql
-- Top CPU offenders with LIKE patterns
SELECT substring(query from 1 for 200) as q, calls,
  round(total_exec_time::numeric / 1000) as total_sec,
  round(mean_exec_time::numeric) as avg_ms
FROM pg_stat_statements
WHERE query ILIKE '%price_history_points%' AND query ILIKE '%like%'
ORDER BY total_exec_time DESC LIMIT 5;
```

**Fix:** Commit `e415db8` — gated the LIKE-OR branch behind env flag `PROVIDER_OBSERVATION_CLEANUP_LIKE_FALLBACK_ENABLED` (default **off**). Losing this cleanup is safe: `prune_old_data()` runs daily with a 90-day retention cut and reaps the same rows the LIKE-OR was chasing. Daily prune is slower than immediate cleanup, but the cleanup was costing us more than it was saving.

**Lesson:** OR-joined `LIKE` on a >1M-row table is a CPU trap, even when each pattern is anchored. If you find yourself writing `field LIKE 'a%' OR field LIKE 'b%' OR ...`, stop — either pre-resolve to exact matches and use `IN`, or use a GIN trigram index. The former is almost always the right call.

---

#### 14b. Cascade failures that had been masked by the LIKE-OR's timeout budget

After gating 14a, three problems surfaced that had been silently failing inside the 480s budget the LIKE-OR was eating.

**Cascade 1: PostgREST URL overflow on the happy-path lookup.** Line 510-514 of `provider-observation-timeseries.ts` did `.in("provider_ref", providerRefs)` with 200+ items unchunked. That overflows PostgREST's URL limit and returns HTTP 400 "Bad Request". Previously, the LIKE-OR was timing out before this code ran, so the 400 never surfaced. Fixed in commit `11de000` by chunking via the existing `chunkValues(..., STALE_DELETE_PROVIDER_REF_CHUNK_SIZE)` pattern already used elsewhere in the file.

**Cascade 2: `variant_metrics_printing_key_variant_ref_chk` constraint violation.** Migration 20260416 tightened the constraint so `variant_ref` shape must match `grade` (RAW shape for RAW grade, graded shape for graded grades). `runProviderObservationVariantMetrics` in [lib/backfill/provider-observation-variant-metrics.ts](../lib/backfill/provider-observation-variant-metrics.ts) unconditionally built `variant_ref = buildRawVariantRef(printingId)` (always RAW shape), but `shouldWriteObservation` at line 143 let graded observations through. Result: graded rows with RAW-shaped `variant_ref` → constraint violation. Fixed in commit `33cc91b` by inverting the guard to skip non-RAW observations. The analytics providers (SCRYDEX/JUSTTCG/POKETRACE) have no path for graded writes through this function anyway — graded data flows through `app/api/ingest/psa` separately.

**Cascade 2b: empty-string / case-sensitivity fallthrough.** First pass used `if (grade && grade !== "RAW")`. That's false when `grade === ""` (empty string is falsy), so empty-grade observations still got written with `grade=""` and violated the constraint. It would also incorrectly reject lowercase `"raw"`. Fixed in commit `e5a3386`: uppercase-normalize before comparing with strict `grade !== "RAW"`, and force literal `"RAW"` on the write side instead of trusting the observation's passed-through grade.

**Lesson:** When you remove a timeout-hog, budget for surprise errors downstream. Any code that previously never got to run in 480s will start running — and its own bugs will surface. Gate changes like 14a behind a flag and watch the failure distribution for one full cron cycle before declaring victory.

---

#### 14c. The silent structural bug: `DISTINCT ON` literal string, broken since 2026-04-07 (the actual cause of user-visible stale prices)

**Root cause:** Migration `20260407000000_remove_justtcg_from_scoped_refresh.sql` replaced `ps.provider` with the string literal `'SCRYDEX'` in BOTH the `DISTINCT ON` list and the `ORDER BY` list of the `provider_latest_by_ref_raw` CTE inside `refresh_card_metrics_for_variants()`. Postgres rejects non-integer constants in both clauses. Migration `20260409140000_fix_scrydex_literal_in_order_by.sql` (incident #1) patched the `ORDER BY` side but missed `DISTINCT ON`. So **every call to `refresh_card_metrics_for_variants()` has aborted with `non-integer constant in DISTINCT ON` since 2026-04-07** — nine days of silent breakage.

**Why nobody noticed for nine days (this is the important part):**

1. `pg_stat_statements` showed `claim_pending_rollups` called 1,547 times but `refresh_card_metrics_for_variants` with **0 calls**. That's the giveaway: Postgres aborts parse-time before execution counts are incremented. If a JS client is calling an RPC and pg_stat_statements shows 0 calls, the call is being rejected syntactically — not a schema cache miss, not a permissions issue (those *are* counted).
2. The other targeted RPCs in the same drain (`refresh_price_changes_for_cards`, `refresh_card_market_confidence_for_cards`) both had call count 1,494 — matching each other but 53 below `claim_pending_rollups`. The drain was running; it was just silently failing the first RPC in the chain and moving on.
3. [lib/backfill/provider-pipeline-rollups.ts:90-107](../lib/backfill/provider-pipeline-rollups.ts) only falls back to the full-sweep `refresh_card_metrics()` when the error message contains `"function does not exist"` or `"could not find the function"`. Our actual error (`non-integer constant in DISTINCT ON`) matched neither, so the fallback never fired. The error got stashed in `cardMetricsError` and the drain moved on.
4. Consequence: `public_card_metrics.market_price_as_of` only advanced when the `refresh-card-metrics` cron (every 12h at :15) ran its full-sweep backstop. Between ticks, users saw 12+ hour stale prices — even though ingestion was healthy and `price_snapshots` were current.

**Diagnostic query:**
```sql
-- If this returns rows with current timestamps and the RPC has 0 calls, the RPC is parse-aborting.
SELECT
  (SELECT MAX(observed_at) FROM price_snapshots WHERE provider='SCRYDEX') as snapshots_newest,
  (SELECT MAX(market_price_as_of) FROM public_card_metrics
    WHERE grade='RAW' AND printing_id IS NULL) as metrics_newest,
  NOW() - (SELECT MAX(market_price_as_of) FROM public_card_metrics
    WHERE grade='RAW' AND printing_id IS NULL) as lag;

-- Cross-check: if the RPC is actually being called
SELECT query, calls, round(mean_exec_time::numeric) as avg_ms
FROM pg_stat_statements
WHERE query ILIKE '%refresh_card_metrics_for_variants%';
```
If `snapshots_newest` is current but `metrics_newest` lags by hours, and the RPC shows 0 calls while `claim_pending_rollups` shows thousands — same bug shape.

**Fix:** Commit `097b6e0` — migration `supabase/migrations/20260416230000_fix_scrydex_literal_in_distinct_on.sql` uses the same `replace(prosrc, ...)` string-substitution approach as the 04-09 fix, patching the `DISTINCT ON` clause (`ps.grade,\n  'SCRYDEX',\n  ps.provider_ref` → `ps.grade,\n  ps.provider,\n  ps.provider_ref`). Also shipped `sql/ops/fix-rollup-rpc-20260416.sql` as a self-contained Studio-pasteable snippet. Idempotent — no-ops if the pattern isn't present.

**Lesson:** Three compounding rules come out of this one.

- **`pg_stat_statements` "0 calls" for an RPC the JS client is definitely calling = Postgres is rejecting the call before execution counts.** Not schema cache, not permissions (both are tracked). Parse-time and syntactic failures are the most common cause. If you see this asymmetry, the function body is broken and Postgres is telling you.
- **Silent fallback that only fires on specific error strings is a bug smell.** `provider-pipeline-rollups.ts` swallowed `non-integer constant in DISTINCT ON` for nine days because its fallback pattern match was too narrow. If you're going to have a fallback, either widen it to any RPC error or emit the error to a dedicated sink where future Claude will notice it. See "Preventative follow-ups" below.
- **"Only 7k cards have fresh prices" is a freshness proxy, not a coverage metric.** The user was conflating `market_price IS NOT NULL` (19,431 — fine) with `market_price_as_of > now() - interval '24 hours'` (9,820 — the actual problem). Always distinguish the two in triage queries.

---

#### String-substitution migrations: acceptable but fragile

The 04-09 migration (incident #1) and today's 04-16 `DISTINCT ON` migration both use `replace(prosrc, ...)` to patch one clause of a SQL function without rewriting the whole body. It's idempotent and no-ops cleanly when the pattern doesn't match. This is the right tool when you want to leave surrounding code untouched and when a full `CREATE OR REPLACE FUNCTION` would conflict with unrelated changes. But it's brittle: if someone reformats the function, the pattern stops matching and the migration silently does nothing. Always document the pattern match assumption inline in the migration and treat these as temporary patches — roll them into a full `CREATE OR REPLACE` the next time you need to touch the function for other reasons.

---

#### Preventative follow-ups (do these soon)

- **Widen the rollup fallback in [lib/backfill/provider-pipeline-rollups.ts:90-107](../lib/backfill/provider-pipeline-rollups.ts) to catch any RPC error**, not just `"function does not exist"` / `"could not find the function"`. At minimum, log every caught error to a dedicated `rollup_errors` table or structured log stream so the next instance of 14c is visible in under an hour, not nine days.
- **Bulk downsample `price_history_points` (Phase 3 from `/Users/popalpha/.claude/plans/delightful-swinging-music.md`).** The 14a gating reduces pressure on the table but doesn't shrink it. Baseline CPU is still higher than it should be.
- **Requeue the 1,048 FAILED jobs via `sql/ops/unblock-pipeline-queue-20260416.sql`.** Staged for tomorrow, not yet run. Check `pipeline_jobs` FAILED count before executing — if it's drifted, re-scope the file.
- **Consider dropping `cleanupStaleProviderVariantWrites` entirely.** `prune_old_data`'s 90-day retention already reaps what this function was trying to clean up immediately, and the function's internal complexity is what spawned 14a in the first place. The 14a env flag keeps it gated off today; flipping from "gated off" to "deleted" removes a whole class of future incidents.

**Fix summary (all on main, all deployed 2026-04-16):**

| Commit | Scope |
|--------|-------|
| `e415db8` | Gate LIKE-OR fallback in `provider-observation-timeseries.ts` behind env flag |
| `11de000` | Chunk `.in("provider_ref", ...)` lookup to avoid PostgREST URL overflow |
| `33cc91b` | `provider-observation-variant-metrics.ts` — skip non-RAW observations |
| `e5a3386` | Uppercase-normalize grade, strict `!== "RAW"`, force literal `"RAW"` on write |
| `097b6e0` | Migration `20260416230000_fix_scrydex_literal_in_distinct_on.sql` — patches `DISTINCT ON` clause |

**Files touched:**
- [lib/backfill/provider-observation-timeseries.ts](../lib/backfill/provider-observation-timeseries.ts)
- [lib/backfill/provider-observation-variant-metrics.ts](../lib/backfill/provider-observation-variant-metrics.ts)
- [supabase/migrations/20260416230000_fix_scrydex_literal_in_distinct_on.sql](../supabase/migrations/20260416230000_fix_scrydex_literal_in_distinct_on.sql)
- [sql/ops/triage-pipeline-cpu-saturation.sql](../sql/ops/triage-pipeline-cpu-saturation.sql) — triage SQL
- [sql/ops/fix-rollup-rpc-20260416.sql](../sql/ops/fix-rollup-rpc-20260416.sql) — Studio-pasteable fix
- [sql/ops/unblock-pipeline-queue-20260416.sql](../sql/ops/unblock-pipeline-queue-20260416.sql) — staged, unused

---

### 15. `refresh_price_changes` body-lifted from an old migration → coverage gate tripped → homepage stale for 2 days (2026-05-01)

**Symptom.** User reported the homepage rails (Top Movers, Biggest Drops, momentum, etc.) had been showing identical cards for two consecutive days. iOS pull-to-refresh produced no change. The `daily_top_movers` table's newest `computed_at_date` was 2026-04-30 — neither May 1 nor May 2 had written a row.

**Root cause.** Migration [`20260501010000_refresh_price_changes_time_anchored_baseline.sql`](../supabase/migrations/20260501010000_refresh_price_changes_time_anchored_baseline.sql) was authored to fix sparse-card 24h/7d delta inflation. The new function body was **lifted from `20260303115000_refresh_price_changes_no_lock_timeout.sql`** — an old JustTCG-only definition — and modified to add the time-anchor windows. But the *latest* prior body was `refresh_price_changes_core(...)` (in `20260317093000_phase1_public_live_market_truth_followup.sql`) wrapped by a thin `refresh_price_changes()` (in `20260309224000_fix_price_change_scope_selection.sql`); the latest wrapper did NOT touch `market_price` or `market_price_as_of` at all.

The lifted body re-introduced an UPDATE clause:

```sql
update public.card_metrics cm
set market_price       = c.price_now,
    market_price_as_of = c.latest_ts
```

sourcing `latest_ts` from JUSTTCG. JustTCG polls at a much lower cadence than Scrydex, so on every cron tick this clobbered Scrydex-fresh `market_price_as_of` values across thousands of canonical RAW rows. The catalog-wide `fresh_24h` count cratered from ~18k+ to ~2.6k, tripping the `coverage_too_low` gate inside `compute_daily_top_movers` (threshold 18,000). The cron silently returned `{ ok: true, computed: false, reason: 'coverage_too_low' }` for the next four scheduled runs, so [`daily_top_movers`](../lib/data/homepage.ts) never got May-1 or May-2 rows. The homepage's `loadDailyTopMoversBundle` falls back to the most-recent existing row, which was April 30's — for both days.

**Detection.** Pure symptomatic — a human looked at the homepage and noticed Rayquaza-Deoxys was still featured. There was no monitoring on the gate trip; the cron logged `console.log` (not `console.error`), so Vercel didn't surface it as an error.

**Fix (commit `c6f0dca`, 2026-05-02 00:06 EDT).** Migration [`20260502010000_revert_refresh_price_changes_to_core_wrapper.sql`](../supabase/migrations/20260502010000_revert_refresh_price_changes_to_core_wrapper.sql) restores `refresh_price_changes()` to a thin wrapper around `refresh_price_changes_core(null)` — the actual time-anchored logic that already lived in `_core` and was the intended target of the May-1 work. Manual data repopulation (run in Supabase SQL editor):

```sql
SELECT public.refresh_card_metrics();      -- restore market_price_as_of from real Scrydex snapshots
SELECT public.refresh_price_changes();     -- recompute change_pct via _core
SELECT public.compute_daily_top_movers();  -- re-bake homepage rails (idempotent)
```

The `compute_daily_top_movers()` call is idempotent — it `DELETE`s today's rows and rewrites them — so it's safe to run mid-day even if a cron later fires the same day's compute.

**Lessons.**

- **Filename match ≠ active body.** Postgres functions get redefined dozens of times across migrations. `refresh_price_changes` had been redefined 11 times before the May-1 incident (the search hit migrations from March-3 through March-9). Lifting the body from any one of them and modifying it without diffing against the *latest* definer is how this class of bug happens.
- **Watch UPDATE columns.** Diffing the new body's UPDATE columns against the latest prior body's is the cheapest red-flag detector. The new body wrote columns the latest prior body did NOT touch (`market_price`, `market_price_as_of`) — that's a clobber, not a change-detection refinement.
- **Silent gate trips hide outages.** The `coverage_too_low` return path was a normal control-flow branch in the cron and logged at `console.log` level. Vercel's log dashboard treats that as healthy; the only signal that anything was wrong was the homepage UI itself.

**Preventative (shipped with this incident's PR):**

- **Migration linter** ([scripts/check-migration-function-body.mjs](../scripts/check-migration-function-body.mjs)) — for every migration that redefines a public function, requires a header comment referencing the latest prior definer (`-- supersedes: <filename>` / `-- Revert of <filename>`). The reference is a forcing function: the author has to open the prior file. Wired into `npm run check:security:invariants`, `npm run check:security:static`, and a pre-deploy step in `.github/workflows/supabase-migrations.yml`.
- **Cron observability** ([app/api/cron/compute-daily-top-movers/route.ts](../app/api/cron/compute-daily-top-movers/route.ts)) — gate trips now `console.error` (not `console.log`) and look back at `daily_top_movers` for the newest existing row. If the rails are stale for ≥2 days the message escalates to "CRITICAL: rails stale for >=2 days". Vercel surfaces `console.error` as an error in the log dashboard.

**Fix summary:**

| Commit | Scope |
|--------|-------|
| `d17becb` | (the bug) `refresh_price_changes` time-anchored baseline — body lifted from old migration |
| `c6f0dca` | Revert `refresh_price_changes` to `_core` wrapper |

**Files touched (preventative):**
- [scripts/check-migration-function-body.mjs](../scripts/check-migration-function-body.mjs) — NEW
- [scripts/check-security-invariants.mjs](../scripts/check-security-invariants.mjs) — registry entry
- [package.json](../package.json) — `check:migrations:fnbody` script + `check:security:static` chain
- [.github/workflows/supabase-migrations.yml](../.github/workflows/supabase-migrations.yml) — pre-deploy step
- [app/api/cron/compute-daily-top-movers/route.ts](../app/api/cron/compute-daily-top-movers/route.ts) — gate-trip observability

---

## Operational checklists

### Healthy steady-state signals (copy-paste diagnostic)

Run this first. If all green, the system is healthy and you can go home.

```sql
SELECT
  (SELECT COUNT(*) FROM pipeline_jobs
     WHERE status = 'SUCCEEDED' AND created_at > NOW() - INTERVAL '1 hour') as succeeded_last_1h,
  (SELECT COUNT(*) FROM pipeline_jobs
     WHERE status = 'FAILED' AND last_error NOT LIKE 'KILLED%'
     AND created_at > NOW() - INTERVAL '1 hour') as real_failures_1h,
  (SELECT COUNT(*) FROM pending_rollups) as pending_rollups,
  (SELECT COUNT(DISTINCT canonical_slug) FROM public_card_metrics
     WHERE market_price_as_of > NOW() - INTERVAL '24 hours') as fresh_cards_24h,
  (SELECT COUNT(*) FROM public_card_metrics
     WHERE grade='RAW' AND printing_id IS NULL AND market_price IS NOT NULL) as addressable_catalog,
  (SELECT MAX(market_price_as_of) FROM public_card_metrics
     WHERE grade='RAW' AND printing_id IS NULL) as metrics_newest,
  (SELECT MAX(observed_at) FROM provider_normalized_observations
     WHERE provider='SCRYDEX') as normalized_newest,
  NOW() as now_utc;
```

Green thresholds:
| Column | Healthy | Investigate if |
|---|---|---|
| `succeeded_last_1h` | ≥ 30 | < 10 → processor or job queue issue |
| `real_failures_1h` | ≤ 3 | > 5 → check `last_error` by group |
| `pending_rollups` | 0–800 | > 2,000 and rising → batch cron broken |
| `fresh_cards_24h / addressable_catalog` | ≥ 95% | < 85% → freshness investigation (Q1–Q4 below) |
| `metrics_newest` | within 2h of `now_utc` | > 3h → batch cron under-performing |
| `normalized_newest` | within 1h of `now_utc` | > 2h → pipeline job processor stalled |

### If something looks wrong, run the four freshness-plateau queries

These four queries isolate where in the pipeline the break is. Documented in the pre-incident plan and kept here for posterity.

**Q1 — Is the addressable catalog what you think it is?**
```sql
SELECT
  (SELECT COUNT(*) FROM public_card_metrics WHERE grade='RAW' AND printing_id IS NULL) as total_raw_canonical,
  (SELECT COUNT(*) FROM public_card_metrics WHERE grade='RAW' AND printing_id IS NULL AND market_price IS NOT NULL) as total_with_market_price,
  (SELECT COUNT(*) FROM public_card_metrics WHERE grade='RAW' AND printing_id IS NULL AND market_price IS NULL) as total_without_market_price;
```
The `total_with_market_price` is the true ceiling. Currently ~18,564.

**Q2 — Does the rollup's input have recent data?**
```sql
SELECT COUNT(DISTINCT canonical_slug) as slugs_with_recent_scrydex_snapshot
FROM price_snapshots
WHERE observed_at >= NOW() - INTERVAL '30 days'
  AND provider IN ('SCRYDEX', 'POKEMON_TCG_API')
  AND grade = 'RAW';
```

**Q3 — Are any sets being starved?**
```sql
SELECT
  COUNT(*) FILTER (WHERE last_success_at > NOW() - INTERVAL '24 hours') as fresh_24h,
  COUNT(*) FILTER (WHERE last_success_at > NOW() - INTERVAL '48 hours' AND last_success_at <= NOW() - INTERVAL '24 hours') as stale_24_48h,
  COUNT(*) FILTER (WHERE last_success_at <= NOW() - INTERVAL '48 hours') as stale_48h_plus,
  COUNT(*) FILTER (WHERE last_success_at IS NULL) as never_touched,
  COUNT(*) as total_sets
FROM provider_set_health
WHERE provider = 'SCRYDEX' AND provider_set_id != '__provider__';
```
Healthy: `fresh_24h > 95% of total_sets`.

**Q4 — Is the batch rollup cron advancing timestamps?**
```sql
SELECT
  (SELECT MAX(observed_at) FROM provider_normalized_observations WHERE provider='SCRYDEX') as normalized_newest,
  (SELECT MAX(observed_at) FROM price_snapshots WHERE provider='SCRYDEX') as snapshots_newest,
  (SELECT MAX(market_price_as_of) FROM public_card_metrics WHERE grade='RAW' AND printing_id IS NULL) as metrics_newest,
  NOW() as now_utc;
```
If `normalized/snapshots` are current but `metrics_newest` is far behind → batch rollup cron is broken.

### Incident response flowchart

```
Jobs failing? ────────┐
                       ▼
  Query pipeline_jobs ── GROUP BY last_error
        │
        ├─ "non-integer constant in ORDER BY"
        │      → look for literal strings in an ORDER BY (incident #1)
        │      → or check RPCs for CASE WHEN NULL branches (incident #5)
        │      → or check for .order().range() on a new table (incident #4)
        │
        ├─ "PIPELINE_JOB_TIMEOUT after 480s"
        │      → look for inner statement_timeout cascading (incident #7)
        │      → or genuinely slow scans — check indexes
        │
        ├─ "statement timeout"
        │      → missing index. Run EXPLAIN ANALYZE on the query
        │
        ├─ "Task timed out after N seconds"
        │      → Vercel function cap. Check project Settings → Functions → Max Duration.
        │      → Shrink batches, extend reserve, add more frequent cron fires
        │
        ├─ "KILLED: ..."
        │      → not a failure, we killed it manually. Ignore in failure counts.
        │
        └─ anything else → read full last_result->'steps' to find which stage errored

Pipeline succeeding but freshness lagging? ─┐
                                              ▼
  Run Q4 above. Which stage's newest-timestamp is stale?
        │
        ├─ normalized < snapshots → impossible under normal config, investigate
        ├─ normalized current, snapshots lagging → timeseries stage writes broken
        ├─ snapshots current, metrics lagging → batch rollup cron broken (incident #8)
        │      → check pending_rollups count
        │      → check batch cron Vercel logs for 500 / timeout
        │      → trigger manually from Vercel dashboard to confirm
        └─ everything current but fresh_cards_24h low → either Q3 shows starvation
                                                        or addressable catalog is the ceiling

Homepage shows empty? ─┐
                        ▼
  DB query returning data but homepage empty?
        │
        ├─ YES → frontend timeout issue (incident #10)
        │      → increase DATA_TIMEOUT_MS in app/page.tsx
        │      → verify ISR caching is on (revalidate=60)
        │
        └─ NO (DB empty too) → data flow issue upstream, run Q4

Supabase CPU at 90%+? ─┐
                        ▼
  1. Run pg_stat_statements — find the top CPU consumers
  2. If price_history_points is the top consumer:
     → Check table size (should be ≤ 5M rows)
     → Run downsample-price-history cron manually
     → Kill long-running queries: pg_terminate_backend(pid)
  3. If pipeline stale DELETEs are slow:
     → Verify ts bounds are present in provider-observation-timeseries.ts
  4. Don't increase concurrency/batch sizes — reduce them

Supabase dashboard says depleting disk IO? ─┐
                                              ▼
  Don't increase load — reduce it.
  1. Stop manually triggering crons
  2. Consider pausing daily sweep chunks temporarily
  3. Verify no retry cascade is burning budget (check failed job count trend)
  4. Wait — budget refills during low activity
```

### Manual intervention commands (use sparingly)

**Kill all in-flight jobs:**
```sql
UPDATE pipeline_jobs
SET status = 'FAILED', last_error = 'KILLED: <reason>'
WHERE status IN ('RETRY', 'RUNNING', 'QUEUED');
```

**Queue a minimal test job (1 set, 1 request, ~1 Scrydex credit):**
```sql
INSERT INTO pipeline_jobs (provider, job_kind, status, params_json, priority, max_attempts, created_at)
VALUES ('SCRYDEX', 'PIPELINE', 'QUEUED',
  '{"setLimit": 1, "maxRequests": 1, "matchObservations": 10, "payloadLimit": 1}'::jsonb,
  100, 3, NOW());
```

**Manually drain pending_rollups:**
Trigger `batch-refresh-pipeline-rollups` from Vercel Cron Jobs → "Run". Wait up to ~10 minutes.

**Clear provider cooldown (only if confirmed safe on Scrydex side):**
```sql
UPDATE provider_set_health
SET cooldown_until = NOW(), last_error = 'manual clear'
WHERE provider = 'SCRYDEX' AND provider_set_id = '__provider__';
```

---

## Things not to do (learned the hard way)

- **Don't set `statement_timeout` inside scan RPCs.** The outer job timeout is the authoritative cap. Inner timeouts cause drain-loop retry cascades.
- **Don't use `CASE WHEN` in ORDER BY** unless every branch references an actual column. A NULL branch is treated as a constant and errors.
- **Don't use `.order().range()` in new PostgREST client code on match-path tables.** Use the RPC pattern.
- **Don't trust per-file `maxDuration` without checking Vercel project-level Function Max Duration.** The project cap silently overrides.
- **Don't set homepage to `force-dynamic` if queries read heavy aggregate tables.** ISR with 30–60s revalidate is almost always the right call.
- **Don't increase Scrydex call volume to fix a DB problem.** The goal is minimum credit burn. If DB is slow, tune DB; don't poll Scrydex more.
- **Don't bundle sets per job (`setLimit > 1`) without a specific reason.** It makes jobs heavier, slower, and more timeout-prone.
- **Don't forget the five "rollup-dependent" stats**: `market_price_as_of`, `change_pct_24h/7d`, `market_confidence_score`, `canonical_raw_provider_parity`, set summaries. All are updated by `refresh_card_metrics_for_variants` + its four siblings, which are deferred through `pending_rollups`. They lag up to ~30 minutes. Any UI that depends on sub-minute freshness of these stats needs a different architecture.
- **Don't try to fix disk IO exhaustion by running more crons.** That's backwards. Reduce load, let the budget refill.
- **Don't query `price_history_points` without a `ts` bound.** This table is 8+ GB. Any WHERE clause without `ts >= <cutoff>` does a full-table scan and takes 120+ seconds. Always include `ts >= now() - interval 'N days'`.
- **Don't increase cron concurrency or batch sizes without checking CPU first.** Run `pg_stat_activity` to see if queries are already slow. If avg query time > 30s, the DB is saturated — more load will make it worse, not better.
- **Don't let `price_history_points` grow beyond 5M rows.** The downsample system keeps it at ~3-4M by reducing old data to 1 point/card/day. If it grows past 5M, check that `prune_old_data()` step 7b and the downsample cron are running.
- **Don't mark a real failure as KILLED.** The `KILLED:` prefix is a sentinel for "this was a manual intervention, exclude from failure-rate math". Preserve the convention.

---

## Success criteria (revisited)

When this system is healthy, all of these are true simultaneously:

1. `fresh_cards_24h / addressable_catalog` ≥ 95% at all times
2. `real_failures_1h` ≤ 5 (excluding `KILLED` sentinels)
3. Scrydex API calls per day ≤ ~150 (daily budget + headroom)
4. `pending_rollups` oscillates in the 0–800 range, drains on every `:10`/`:40` cron fire
5. Homepage loads in < 2 s and always shows populated card rails
6. Supabase disk IO budget stays ≥ 50% on average
7. `metrics_newest` is within 2 hours of `NOW()`
8. No single job exceeds 60s exec time (under `started_at → updated_at`)

9. `price_history_points` row count ≤ 5M (downsampling keeping it lean)
10. CPU utilization ≤ 60% average (check Supabase dashboard)

**The job of future Claude is to keep it in this state**, which mostly means: **don't regress any of the 13 fixes above** and **monitor `price_history_points` table size monthly**.
