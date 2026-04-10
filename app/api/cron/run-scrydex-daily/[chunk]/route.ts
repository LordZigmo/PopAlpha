import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";
import { getProviderCooldownState } from "@/lib/backfill/provider-cooldown";
import { planScrydexDailyCapture } from "@/lib/backfill/scrydex-price-history";

export const runtime = "nodejs";
export const maxDuration = 300;

const SCRYDEX_DAILY_CHUNK_COUNT = 8;

function parseChunkParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > SCRYDEX_DAILY_CHUNK_COUNT) {
    throw new Error(`chunk must be between 1 and ${SCRYDEX_DAILY_CHUNK_COUNT}`);
  }
  return parsed;
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ chunk: string }> },
) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const { chunk } = await context.params;
    const chunkNumber = parseChunkParam(chunk);
    const url = new URL(req.url);
    const matchObservations = parseOptionalInt(url.searchParams.get("observations")) ?? 100;
    const timeseriesObservations = parseOptionalInt(url.searchParams.get("timeseriesObservations")) ?? matchObservations;
    const metricsObservations = parseOptionalInt(url.searchParams.get("metricsObservations")) ?? timeseriesObservations;
    const maxRequests = parseOptionalInt(url.searchParams.get("maxRequests"));
    const force = url.searchParams.get("force") === "1";

    const providerCooldown = await getProviderCooldownState("SCRYDEX");
    if (providerCooldown.active && !force) {
      return NextResponse.json({
        ok: true,
        mode: "blocked",
        chunk: chunkNumber,
        chunkCount: SCRYDEX_DAILY_CHUNK_COUNT,
        reason: "provider_cooldown_active",
        cooldownUntil: providerCooldown.cooldownUntil,
        providerSetIds: [],
        plannedRequests: 0,
        plannedExpectedCardCount: 0,
        plannedMatchedCardCount: 0,
        queuedJobs: 0,
        runs: [],
      });
    }

    // Each chunk enqueues ALL sets that need coverage. The job queue dedup
    // skips sets with active QUEUED/RUNNING/RETRY jobs, so only failed or
    // unqueued sets get new jobs. This makes every 3-hour chunk a catch-up
    // pass instead of a static partition.
    const plan = await planScrydexDailyCapture({
      chunkCount: 1,
      maxRequests,
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
          timeseriesObservations,
          metricsObservations,
          force,
        },
        priority: 125,
      });

      if (queued.enqueued) queuedJobs += 1;
      ok = ok && (queued.enqueued || queued.reason.startsWith("existing_") || queued.reason === "provider_cooldown_active");
      runs.push({
        providerSetId,
        setCode: selectedSet.setCode ?? providerSetId,
        setName: selectedSet.setName ?? providerSetId,
        expectedCardCount: selectedSet.expectedCardCount,
        providerCardCount: selectedSet.providerCardCount,
        matchedCardCount: selectedSet.matchedCardCount,
        dailyCaptureRequests,
        priorityWeight: selectedSet.priorityWeight,
        priorityReasons: selectedSet.priorityReasons,
        enqueued: queued.enqueued,
        jobId: queued.jobId,
        reason: queued.reason,
      });
    }

    return NextResponse.json({
      ok,
      mode: "queued",
      chunk: chunkNumber,
      chunkCount: SCRYDEX_DAILY_CHUNK_COUNT,
      generatedAt: plan.generatedAt,
      totalAvailableRequests: plan.totalAvailableRequests,
      maxRequests: plan.maxRequests,
      recentSuccessfulRequests: plan.recentSuccessfulRequests,
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
