/**
 * Cron: run-scrydex-weekly-dormant
 *
 * Phase 4 of the tiered-refresh plan. The daily Scrydex cron filters
 * out dormant-heavy sets (>50% of matched cards have no SCRYDEX
 * snapshot in the last 30d) so we don't burn budget refreshing the
 * long tail. This cron picks them up once per week so their snapshots
 * don't go completely stale.
 *
 * Same enqueue path as /api/cron/run-scrydex-daily — only difference
 * is `dormantHeavyMode: "only"`, so the planner returns ONLY the
 * dormant-heavy sets the daily cron skipped.
 *
 * Schedule: weekly, Sunday 06:00 UTC. Runs after recompute-refresh-tier
 * (04:30 UTC Sunday) so tier labels are current before we pick which
 * sets to fetch.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";
import { getProviderCooldownState } from "@/lib/backfill/provider-cooldown";
import {
  calculateScrydexStageObservationBudget,
  planScrydexDailyCapture,
} from "@/lib/backfill/scrydex-price-history";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const matchObservations = parseOptionalInt(url.searchParams.get("observations")) ?? 100;
    // Stage budgets follow the same volume-aware default as the daily
    // cron (see calculateScrydexStageObservationBudget — 2026-06-10
    // starvation incident); explicit query params still override.
    const timeseriesObservationsOverride = parseOptionalInt(url.searchParams.get("timeseriesObservations"));
    const metricsObservationsOverride = parseOptionalInt(url.searchParams.get("metricsObservations"));
    const maxRequests = parseOptionalInt(url.searchParams.get("maxRequests"));
    const force = url.searchParams.get("force") === "1";

    const providerCooldown = await getProviderCooldownState("SCRYDEX");
    if (providerCooldown.active && !force) {
      return NextResponse.json({
        ok: true,
        mode: "blocked",
        reason: "provider_cooldown_active",
        cooldownUntil: providerCooldown.cooldownUntil,
        providerSetIds: [],
        plannedRequests: 0,
        queuedJobs: 0,
        runs: [],
      });
    }

    const plan = await planScrydexDailyCapture({
      chunkCount: 1,
      maxRequests,
      dormantHeavyMode: "only",
    });
    const providerSetIds = plan.selectedSets.map((s) => s.providerSetId);

    const runs = [];
    let ok = true;
    let plannedRequests = 0;
    let queuedJobs = 0;

    for (const selectedSet of plan.selectedSets) {
      const providerSetId = selectedSet.providerSetId;
      const dailyCaptureRequests = Math.max(1, selectedSet.dailyCaptureRequests);
      plannedRequests += dailyCaptureRequests;

      const setStageBudget = calculateScrydexStageObservationBudget(selectedSet.expectedCardCount);

      const queued = await enqueuePipelineJob({
        provider: "SCRYDEX",
        jobKind: "PIPELINE",
        params: {
          providerSetId,
          setLimit: 1,
          pageLimitPerSet: dailyCaptureRequests,
          maxRequests: dailyCaptureRequests,
          payloadLimit: dailyCaptureRequests,
          matchObservations,
          timeseriesObservations: timeseriesObservationsOverride ?? setStageBudget,
          metricsObservations: metricsObservationsOverride ?? setStageBudget,
          force,
        },
        // Slightly lower priority than the daily cron's 125 — the
        // daily run should always have queue precedence.
        priority: 110,
      });

      if (queued.enqueued) queuedJobs += 1;
      ok = ok && (queued.enqueued || queued.reason.startsWith("existing_") || queued.reason === "provider_cooldown_active");
      runs.push({
        providerSetId,
        setCode: selectedSet.setCode ?? providerSetId,
        setName: selectedSet.setName ?? providerSetId,
        expectedCardCount: selectedSet.expectedCardCount,
        matchedCardCount: selectedSet.matchedCardCount,
        dailyCaptureRequests,
        priorityWeight: selectedSet.priorityWeight,
        priorityReasons: selectedSet.priorityReasons,
        enqueued: queued.enqueued,
        jobId: queued.jobId,
        reason: queued.reason,
      });
    }

    console.log("[cron/run-scrydex-weekly-dormant] done", {
      mode: plan.dormantHeavyMode,
      selectedSets: plan.selectedSets.length,
      queuedJobs,
      plannedRequests,
    });

    return NextResponse.json({
      ok,
      mode: "queued",
      generatedAt: plan.generatedAt,
      totalAvailableRequests: plan.totalAvailableRequests,
      maxRequests: plan.maxRequests,
      dormantHeavyMode: plan.dormantHeavyMode,
      providerSetIds,
      plannedRequests,
      selectedSets: plan.selectedSets.length,
      queuedJobs,
      runs,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
