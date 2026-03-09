/**
 * Cron: sync-tcg-prices
 *
 * Retired. Provider price ingestion now runs through the normalized provider
 * pipelines and writes into price_snapshots / price_history_points rather than
 * listing_observations.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    ok: true,
    retired: true,
    replacement: [
      "/api/cron/run-scrydex-pipeline",
      "/api/cron/process-provider-pipeline-jobs",
    ],
  });
}
