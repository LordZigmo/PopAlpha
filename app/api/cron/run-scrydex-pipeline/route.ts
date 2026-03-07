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
    const set = url.searchParams.get("set")?.trim() || undefined;
    const force = url.searchParams.get("force") === "1";
    const executeInline = url.searchParams.get("execute") === "1";
    const params = {
      providerSetId: set ?? null,
      setLimit: parseOptionalInt(url.searchParams.get("sets")) ?? 4,
      pageLimitPerSet: parseOptionalInt(url.searchParams.get("pages")),
      maxRequests: parseOptionalInt(url.searchParams.get("maxRequests")) ?? 80,
      payloadLimit: parseOptionalInt(url.searchParams.get("payloads")) ?? 60,
      matchObservations: parseOptionalInt(url.searchParams.get("observations")) ?? 120,
      timeseriesObservations: parseOptionalInt(url.searchParams.get("timeseriesObservations")) ?? 120,
      force,
    };

    if (!executeInline) {
      const queued = await enqueuePipelineJob({
        provider: "SCRYDEX",
        jobKind: "PIPELINE",
        params,
        priority: 120,
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
      providerSetId: params.providerSetId ?? undefined,
      setLimit: params.setLimit,
      pageLimitPerSet: params.pageLimitPerSet,
      maxRequests: params.maxRequests,
      payloadLimit: params.payloadLimit,
      matchObservations: params.matchObservations,
      timeseriesObservations: params.timeseriesObservations,
      force: params.force,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
