import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";
import { getProviderCooldownState } from "@/lib/backfill/provider-cooldown";
import { loadScrydexSetFootprints } from "@/lib/backfill/scrydex-price-history";
import { splitProviderSetIdsIntoDailyChunks } from "@/lib/backfill/scrydex-2024plus-targets";

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
    const matchObservations = parseOptionalInt(url.searchParams.get("observations")) ?? 500;
    const timeseriesObservations = parseOptionalInt(url.searchParams.get("timeseriesObservations")) ?? matchObservations;
    const metricsObservations = parseOptionalInt(url.searchParams.get("metricsObservations")) ?? timeseriesObservations;
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
        queuedJobs: 0,
        runs: [],
      });
    }

    const footprints = await loadScrydexSetFootprints();
    const allProviderSetIds = footprints
      .map((footprint) => footprint.providerSetId)
      .filter((providerSetId) => providerSetId.length > 0);
    const providerSetIds = splitProviderSetIdsIntoDailyChunks(allProviderSetIds, SCRYDEX_DAILY_CHUNK_COUNT)[chunkNumber - 1] ?? [];
    const footprintBySet = new Map(footprints.map((footprint) => [footprint.providerSetId, footprint] as const));

    const runs = [];
    let ok = true;
    let plannedRequests = 0;
    let queuedJobs = 0;

    for (const providerSetId of providerSetIds) {
      const footprint = footprintBySet.get(providerSetId);
      const dailyCaptureRequests = Math.max(1, footprint?.dailyCaptureRequests ?? 1);
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
        setCode: footprint?.setCode ?? providerSetId,
        setName: footprint?.setName ?? providerSetId,
        expectedCardCount: footprint?.expectedCardCount ?? 0,
        providerCardCount: footprint?.providerCardCount ?? 0,
        matchedCardCount: footprint?.matchedCardCount ?? 0,
        dailyCaptureRequests,
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
      providerSetIds,
      plannedRequests,
      queuedJobs,
      runs,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
