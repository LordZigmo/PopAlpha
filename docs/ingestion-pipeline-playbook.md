# Ingestion Pipeline Playbook

**Audience:** Future Claude (or any engineer) debugging, tuning, or extending the Scrydex ingestion pipeline.

**Last updated:** 2026-04-11 after a multi-day incident that took the pipeline from completely broken back to 100% catalog freshness.

---

## The goal (read this first — everything else follows from it)

> **Keep 24-hour price freshness high for as many cards as possible, while minimizing Scrydex credit burn and Supabase resource utilization.**

Three hard constraints, ranked by priority:

1. **Freshness** — `fresh_cards_24h / addressable_catalog` should stay ≥ 95%. `addressable_catalog` is `COUNT(*) FROM public_card_metrics WHERE grade='RAW' AND printing_id IS NULL AND market_price IS NOT NULL` (currently ~18,600). The total canonical count (~19,570) is **not** the right denominator — 1,000+ cards have no market price at all and can never be "fresh".
2. **Scrydex credits** — the only upstream cost. Price history calls are 3 credits/card; daily request budget fallback is 120/day with 1.15× headroom. Every optimization must be credit-neutral or credit-negative. Never increase call volume to fix a perf issue.
3. **Supabase compute + disk IO** — these get exhausted by runaway pipelines. Disk IO burst budget in particular is the first thing to burn, and once depleted you're throttled to baseline and everything starts cascading.

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
| `batch-refresh-pipeline-rollups` | Twice hourly (:10, :40) | Drain `pending_rollups` through 5 refresh RPCs |
| `refresh-card-metrics` | Every 6h (:15) | Backstop full sweep in case targeted refresh misses anything |
| `snapshot-price-history` | Every 6h (:30) | Full pricing snapshot via `snapshot_price_history()` |
| `refresh-set-summaries` | Daily 09:00 UTC | 4 heavy set-level refreshes |
| `refresh-derived-signals` | Daily 08:00 UTC | Variant signal reconcile |
| Various | Various | FX rates, embeddings, PSA, transparency audits |

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

You are currently in this state. **The job of future Claude is to keep it in this state**, which mostly means: **don't regress any of the 10 fixes above**.
