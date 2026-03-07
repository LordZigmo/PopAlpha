import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  claimNextPipelineJob,
  completePipelineJob,
  executeClaimedPipelineJob,
  retryDelayForAttempt,
} from "@/lib/backfill/provider-pipeline-job-queue";

export const runtime = "nodejs";
export const maxDuration = 300;

type GlobalRefreshResult = {
  cardMetrics: unknown;
  cardMetricsError: string | null;
  priceChanges: unknown;
  priceChangesError: string | null;
  parity: unknown;
  parityError: string | null;
};

async function runGlobalRefreshCycle(): Promise<GlobalRefreshResult> {
  const supabase = dbAdmin();
  let cardMetrics: unknown = null;
  let cardMetricsError: string | null = null;
  let priceChanges: unknown = null;
  let priceChangesError: string | null = null;
  let parity: unknown = null;
  let parityError: string | null = null;

  try {
    const { data, error } = await supabase.rpc("refresh_card_metrics");
    if (error) cardMetricsError = error.message;
    else cardMetrics = data;
  } catch (err) {
    cardMetricsError = err instanceof Error ? err.message : String(err);
  }

  try {
    const { data, error } = await supabase.rpc("refresh_price_changes");
    if (error) priceChangesError = error.message;
    else priceChanges = data;
  } catch (err) {
    priceChangesError = err instanceof Error ? err.message : String(err);
  }

  try {
    const { data, error } = await supabase.rpc("refresh_canonical_raw_provider_parity", { p_window_days: 30 });
    if (error) parityError = error.message;
    else parity = data;
  } catch (err) {
    parityError = err instanceof Error ? err.message : String(err);
  }

  return {
    cardMetrics,
    cardMetricsError,
    priceChanges,
    priceChangesError,
    parity,
    parityError,
  };
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(parseOptionalInt(url.searchParams.get("limit")) ?? 3, 3));
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

  const shouldRunGlobalRefresh = runs.length > 0;
  const globalRefresh = shouldRunGlobalRefresh
    ? await runGlobalRefreshCycle()
    : null;

  return NextResponse.json({
    ok: true,
    workerId,
    requestedLimit: limit,
    processed: runs.length,
    succeeded: runs.filter((row) => row.ok).length,
    failed: runs.filter((row) => !row.ok).length,
    runs,
    globalRefresh,
  });
}
