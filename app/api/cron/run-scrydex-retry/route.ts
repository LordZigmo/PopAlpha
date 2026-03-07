import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runScrydexPipeline } from "@/lib/backfill/provider-pipeline-orchestrator";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const executeInline = url.searchParams.get("execute") === "1";
    const params = {
      setLimit: parseOptionalInt(url.searchParams.get("sets")) ?? 3,
      pageLimitPerSet: parseOptionalInt(url.searchParams.get("pages")),
      maxRequests: parseOptionalInt(url.searchParams.get("maxRequests")) ?? 60,
      payloadLimit: parseOptionalInt(url.searchParams.get("payloads")) ?? 40,
      matchObservations: parseOptionalInt(url.searchParams.get("observations")) ?? 90,
      timeseriesObservations: parseOptionalInt(url.searchParams.get("timeseriesObservations")) ?? 90,
      force,
    };

    if (!executeInline) {
      const queued = await enqueuePipelineJob({
        provider: "SCRYDEX",
        jobKind: "RETRY",
        params,
        priority: 80,
      });
      return NextResponse.json({
        ok: true,
        queued: queued.enqueued,
        jobId: queued.jobId,
        reason: queued.reason,
        mode: "queued",
        params,
      });
    }

    const result = await runScrydexPipeline({
      setLimit: params.setLimit,
      pageLimitPerSet: params.pageLimitPerSet,
      maxRequests: params.maxRequests,
      payloadLimit: params.payloadLimit,
      matchObservations: params.matchObservations,
      matchScanDirection: "oldest",
      timeseriesObservations: params.timeseriesObservations,
      force: params.force,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
