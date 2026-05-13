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
 *   ?slug-pattern=  one ilike pattern OR a comma-separated list of
 *                   patterns to scope a canary or production run (e.g.
 *                   "a%" or "a%,b%,c%"). When multiple patterns are
 *                   passed, the writer is invoked sequentially for
 *                   each. Falls back to a single null/all-slugs call
 *                   when the param is omitted entirely.
 *   ?max-slugs=     hard cap on slugs PER PATTERN in this run (default
 *                   200). For multi-pattern runs, the effective total
 *                   per tick is max-slugs × pattern-count.
 *
 * Side effect: also refreshes provider_as_of_ts so the iOS Grade Board's
 * "Updated X ago" timestamp stops staling out — see Phase 0 finding
 * about the 2026-04-15 frozen batch.
 *
 * Consolidation note (2026-05-13): prior schedule was 38 separate cron
 * entries — one per slug-prefix shard ("1%", "a%", "b%", ..., "sw%") —
 * because each shard had to fit Vercel's 60s maxDuration. Combined with
 * 32 other crons, the project sat at 70 total entries, over Vercel
 * Pro's 40-cron quota; over-quota crons silently throttled to daily
 * firing instead of the configured schedule (caught when
 * /api/cron/run-yahoo-jp-daily was only writing 5 cards/day instead of
 * 50/hr). This route now accepts comma-separated patterns + bumps
 * maxDuration to 300, so 38 shards collapse into 8 vercel.json entries.
 * Net cron count drops to 40, back under the quota with margin.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { runGradedVariantMetricsWriter } from "@/lib/backfill/graded-variant-metrics-writer";

export const runtime = "nodejs";
// Bumped from 60s to 300s alongside the multi-pattern support so a
// single cron tick can iterate through 4-7 slug-prefix patterns
// sequentially without timing out on the last few.
export const maxDuration = 300;

const DEFAULT_MAX_SLUGS = 200;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const slugPatternRaw = url.searchParams.get("slug-pattern")?.trim() ?? "";
  const slugPatterns = slugPatternRaw
    ? slugPatternRaw.split(",").map((p) => p.trim()).filter(Boolean)
    : [null]; // null = "all slugs" — preserved legacy behavior

  const maxSlugsParam = url.searchParams.get("max-slugs");
  const maxSlugs = maxSlugsParam
    ? Math.max(1, Math.min(100_000, Number.parseInt(maxSlugsParam, 10) || DEFAULT_MAX_SLUGS))
    : DEFAULT_MAX_SLUGS;

  const startedAt = Date.now();
  const results: Array<{ pattern: string | null; ok: boolean; details: unknown }> = [];
  let anyError = false;

  for (const pattern of slugPatterns) {
    const result = await runGradedVariantMetricsWriter({
      supabase: dbAdmin(),
      slugPattern: pattern,
      maxSlugs,
      logger: console,
    });
    results.push({ pattern, ok: result.ok, details: result });
    if (!result.ok) anyError = true;
    console.log("[cron/refresh-graded-variant-metrics] pattern done", { pattern, ok: result.ok });
  }

  const summary = {
    ok: !anyError,
    patternsProcessed: slugPatterns.length,
    elapsedMs: Date.now() - startedAt,
    results,
  };
  console.log("[cron/refresh-graded-variant-metrics] tick done", {
    patternsProcessed: summary.patternsProcessed,
    elapsedMs: summary.elapsedMs,
    ok: summary.ok,
  });

  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
