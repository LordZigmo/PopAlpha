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

// 2026-04-17: raised drain default from 50 → 150 after the 2026-04-16
// infrastructure cleanup. With the DISTINCT ON rollup bug fixed
// (097b6e0) the refresh_card_metrics_for_variants RPC actually does work
// per call instead of erroring early, and the shrunken price_history_points
// table makes each call cheaper. 150 keys × 30 max batches = 4,500 per
// tick × 2 ticks/hour = 9,000/hour — comfortably above the ~4k/hour we
// need to keep up with post-cap-increase pipeline throughput.
const DEFAULT_BATCH_SIZE = 150;
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
