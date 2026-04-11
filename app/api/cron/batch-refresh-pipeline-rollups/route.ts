/**
 * Cron: batch-refresh-pipeline-rollups
 *
 * Drains the pending_rollups queue that provider pipeline jobs populate
 * when they skip the now-deferred targeted_rollups stage. Runs hourly to
 * keep rollup staleness bounded to ~1 hour while allowing pipeline jobs
 * to complete in ~1-2 minutes instead of ~4 minutes.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { refreshPipelineRollupsForVariantKeys } from "@/lib/backfill/provider-pipeline-rollups";
import {
  claimAndDeletePendingRollups,
  getPendingRollupsCount,
} from "@/lib/backfill/provider-pipeline-rollup-queue";

export const runtime = "nodejs";
export const maxDuration = 600;

const DEFAULT_BATCH_SIZE = 50;
const DEADLINE_RESERVE_MS = 90_000;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const deadline = startedAt + (maxDuration * 1000) - DEADLINE_RESERVE_MS;

  const url = new URL(req.url);
  const batchSize = Math.max(
    100,
    Math.min(
      parseOptionalInt(url.searchParams.get("batchSize")) ?? DEFAULT_BATCH_SIZE,
      5000,
    ),
  );
  const maxBatches = Math.max(
    1,
    Math.min(parseOptionalInt(url.searchParams.get("maxBatches")) ?? 30, 100),
  );

  const batches: Array<{
    index: number;
    claimed: number;
    ok: boolean;
    durationMs: number;
    firstError: string | null;
  }> = [];
  let totalKeys = 0;
  let firstError: string | null = null;

  try {
    for (let i = 0; i < maxBatches; i += 1) {
      if (Date.now() >= deadline) {
        break;
      }

      const batchStart = Date.now();
      const { keys, count } = await claimAndDeletePendingRollups(batchSize);

      if (count === 0) {
        break;
      }
      totalKeys += count;

      const result = await refreshPipelineRollupsForVariantKeys({ keys });
      const durationMs = Date.now() - batchStart;

      batches.push({
        index: i,
        claimed: count,
        ok: result.ok,
        durationMs,
        firstError: result.firstError,
      });

      if (!result.ok && !firstError) {
        firstError = result.firstError ?? "unknown rollup failure";
      }
    }
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  let remaining: number | null = null;
  try {
    remaining = await getPendingRollupsCount();
  } catch {
    // non-fatal - remaining count is informational
  }

  const endedAt = Date.now();
  const ok = firstError === null;

  return NextResponse.json(
    {
      ok,
      job: "batch_refresh_pipeline_rollups",
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      totalDurationMs: endedAt - startedAt,
      batchSize,
      maxBatches,
      batchesProcessed: batches.length,
      totalKeys,
      remainingPending: remaining,
      firstError,
      batches,
    },
    { status: ok ? 200 : 500 },
  );
}
