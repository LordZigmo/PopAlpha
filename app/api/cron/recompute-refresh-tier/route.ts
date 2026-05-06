/**
 * Cron: recompute-refresh-tier
 *
 * Phase 1 of the tiered-refresh plan. Calls apply_refresh_tier_recompute()
 * which recalculates each canonical card's refresh_tier label
 * (hot/warm/sparse/dormant) based on observed match density over the
 * last 180 days, and writes back any transitions.
 *
 * Cadence: weekly (Sunday early UTC). Tier classification doesn't move
 * fast enough to need daily; new-set surges are caught immediately by
 * the hot-promotion fast path inside runProviderObservationVariantMetrics
 * (variant-metrics writes back when a card crosses the hot threshold).
 *
 * Phases 2-4 of the plan layer behavior on top of refresh_tier — UX
 * fallbacks, pipeline skip behavior, dormant-set fetch exclusion. This
 * cron just keeps the labels current.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const supabase = dbAdmin();

  const { data, error } = await supabase.rpc("apply_refresh_tier_recompute");

  if (error) {
    console.error(
      "[cron/recompute-refresh-tier] failed:",
      error.message,
    );
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const durationMs = Date.now() - startedAt;
  console.log("[cron/recompute-refresh-tier] done", { durationMs, result: data });

  return NextResponse.json({ ok: true, durationMs, result: data });
}
