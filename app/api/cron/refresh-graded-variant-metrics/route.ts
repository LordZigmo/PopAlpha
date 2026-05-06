/**
 * Cron: refresh-graded-variant-metrics
 *
 * Phase 4 of the graded surfacing plan. Mirrors the RAW analytics pipeline
 * (lib/backfill/provider-observation-variant-metrics.ts) for graded data:
 * reads price_history_points (graded subset), aggregates per
 * (canonical_slug, printing_id, provider, bucket), computes the same
 * analytics + signals math, and upserts into variant_metrics.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>.
 *
 * Query params (manual operator runs only — production schedule passes
 * neither):
 *   ?slug-pattern=  ilike pattern to scope a canary run (e.g.
 *                   "scarlet-violet-1-%"). Falls back to all slugs when
 *                   omitted.
 *   ?max-slugs=     hard cap on slugs in this run (default 200). Use
 *                   ~100k for full production runs once the canary
 *                   passes.
 *
 * Side effect: also refreshes provider_as_of_ts so the iOS Grade Board's
 * "Updated X ago" timestamp stops staling out — see Phase 0 finding
 * about the 2026-04-15 frozen batch.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { runGradedVariantMetricsWriter } from "@/lib/backfill/graded-variant-metrics-writer";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_MAX_SLUGS = 200;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const slugPattern = url.searchParams.get("slug-pattern")?.trim() || null;
  const maxSlugsParam = url.searchParams.get("max-slugs");
  const maxSlugs = maxSlugsParam ? Math.max(1, Math.min(100_000, Number.parseInt(maxSlugsParam, 10) || DEFAULT_MAX_SLUGS)) : DEFAULT_MAX_SLUGS;

  const result = await runGradedVariantMetricsWriter({
    supabase: dbAdmin(),
    slugPattern,
    maxSlugs,
    logger: console,
  });

  console.log("[cron/refresh-graded-variant-metrics] done", result);

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
