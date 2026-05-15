import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";
import {
  getScrydex2024PlusDailyChunk,
  SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
} from "@/lib/backfill/scrydex-2024plus-targets";
import { loadScrydexSetFootprints } from "@/lib/backfill/scrydex-price-history";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseChunkParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT) {
    throw new Error(`chunk must be between 1 and ${SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT}`);
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

    const providerSetIds = getScrydex2024PlusDailyChunk(chunkNumber);
    const footprints = await loadScrydexSetFootprints();
    const footprintBySet = new Map(footprints.map((footprint) => [footprint.providerSetId, footprint] as const));

    const runs = [];
    let ok = true;
    let plannedRequests = 0;
    let queuedJobs = 0;

    for (const providerSetId of providerSetIds) {
      const footprint = footprintBySet.get(providerSetId);
      if (!footprint || footprint.matchedCardCount <= 0) {
        ok = false;
        runs.push({
          providerSetId,
          ok: false,
          firstError: "SCRYDEX_2024_PLUS_TARGET_NOT_MAPPED",
        });
        continue;
      }

      plannedRequests += footprint.dailyCaptureRequests;
      const queued = await enqueuePipelineJob({
        provider: "SCRYDEX",
        jobKind: "PIPELINE",
        params: {
          providerSetId,
          setLimit: 1,
          pageLimitPerSet: footprint.dailyCaptureRequests,
          maxRequests: footprint.dailyCaptureRequests,
          payloadLimit: footprint.dailyCaptureRequests,
          matchObservations,
          timeseriesObservations,
          metricsObservations,
          force,
        },
        priority: 130,
      });
      if (queued.enqueued) queuedJobs += 1;
      ok = ok && (queued.enqueued || queued.reason.startsWith("existing_"));
      runs.push({
        providerSetId,
        setCode: footprint.setCode,
        setName: footprint.setName,
        dailyCaptureRequests: footprint.dailyCaptureRequests,
        enqueued: queued.enqueued,
        jobId: queued.jobId,
        reason: queued.reason,
      });
    }

    return NextResponse.json({
      ok,
      mode: "queued",
      chunk: chunkNumber,
      chunkCount: SCRYDEX_2024_PLUS_DAILY_CHUNK_COUNT,
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
