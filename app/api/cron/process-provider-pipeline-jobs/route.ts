import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import {
  claimNextPipelineJob,
  completePipelineJob,
  executeClaimedPipelineJob,
  retryDelayForAttempt,
} from "@/lib/backfill/provider-pipeline-job-queue";

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

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(parseOptionalInt(url.searchParams.get("limit")) ?? 1, 3));
  const workerId = url.searchParams.get("workerId")?.trim() || "vercel-cron";

  const runs: Array<{
    jobId: number;
    provider: string;
    kind: string;
    ok: boolean;
    error: string | null;
  }> = [];

  for (let i = 0; i < limit; i += 1) {
    const claimed = await claimNextPipelineJob(workerId);
    if (!claimed) break;

    const executed = await executeClaimedPipelineJob(claimed);
    const retryDelaySeconds = executed.ok ? 0 : retryDelayForAttempt(claimed.attempts);
    await completePipelineJob({
      jobId: claimed.id,
      ok: executed.ok,
      result: executed.result,
      error: executed.error,
      retryDelaySeconds,
    });

    runs.push({
      jobId: claimed.id,
      provider: claimed.provider,
      kind: claimed.job_kind,
      ok: executed.ok,
      error: executed.error,
    });
  }

  return NextResponse.json({
    ok: true,
    workerId,
    requestedLimit: limit,
    processed: runs.length,
    succeeded: runs.filter((row) => row.ok).length,
    failed: runs.filter((row) => !row.ok).length,
    runs,
  });
}

