import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import {
  claimNextPipelineJob,
  completePipelineJob,
  executeClaimedPipelineJob,
  retryDelayForAttempt,
} from "@/lib/backfill/provider-pipeline-job-queue";

export const runtime = "nodejs";
export const maxDuration = 600;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(parseOptionalInt(url.searchParams.get("limit")) ?? 6, 6));
  const workerId = url.searchParams.get("workerId")?.trim() || "vercel-cron";
  const jobTimeoutMs = Math.max(
    5000,
    parseOptionalInt(url.searchParams.get("jobTimeoutMs"))
      ?? (process.env.PIPELINE_JOB_TIMEOUT_MS
        ? parseInt(process.env.PIPELINE_JOB_TIMEOUT_MS, 10)
        : 240000),
  );
  const staleAfterSeconds = Math.max(
    60,
    parseOptionalInt(url.searchParams.get("staleAfterSeconds"))
      ?? (process.env.PIPELINE_JOB_STALE_RECLAIM_SECONDS
        ? parseInt(process.env.PIPELINE_JOB_STALE_RECLAIM_SECONDS, 10)
        : Math.max(360, Math.ceil(jobTimeoutMs / 1000) + 120)),
  );

  const runs: Array<{
    jobId: number;
    provider: string;
    kind: string;
    ok: boolean;
    error: string | null;
    completionError?: string | null;
  }> = [];

  for (let i = 0; i < limit; i += 1) {
    const claimed = await claimNextPipelineJob(workerId, staleAfterSeconds);
    if (!claimed) break;

    let executed = {
      ok: false,
      result: null as unknown,
      error: "PIPELINE_JOB_UNSETTLED" as string | null,
    };
    try {
      executed = await executeClaimedPipelineJob(claimed, { timeoutMs: jobTimeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executed = { ok: false, result: null, error: message };
    }

    let completionError: string | null = null;
    try {
      const retryDelaySeconds = executed.ok ? 0 : retryDelayForAttempt(claimed.attempts);
      await completePipelineJob({
        jobId: claimed.id,
        ok: executed.ok,
        result: executed.result,
        error: executed.error,
        retryDelaySeconds,
      });
    } catch (error) {
      completionError = error instanceof Error ? error.message : String(error);
    }

    runs.push({
      jobId: claimed.id,
      provider: claimed.provider,
      kind: claimed.job_kind,
      ok: executed.ok && !completionError,
      error: completionError
        ? [executed.error, `completion: ${completionError}`].filter(Boolean).join(" | ")
        : executed.error,
      completionError,
    });

    if (completionError) break;
  }

  return NextResponse.json({
    ok: true,
    workerId,
    requestedLimit: limit,
    staleAfterSeconds,
    jobTimeoutMs,
    processed: runs.length,
    succeeded: runs.filter((row) => row.ok).length,
    failed: runs.filter((row) => !row.ok).length,
    runs,
    refreshMode: "inline-targeted-rollups",
  });
}
