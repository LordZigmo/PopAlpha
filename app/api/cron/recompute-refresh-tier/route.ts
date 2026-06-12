/**
 * Cron: recompute-refresh-tier
 *
 * Phase 1 of the tiered-refresh plan. Calls apply_refresh_tier_recompute()
 * which recalculates each canonical card's refresh_tier label
 * (hot/warm/sparse/dormant) based on observed match density over the
 * last 180 days, and writes back any transitions.
 *
 * Also calls apply_jp_refresh_tier_recompute() — the JP sibling
 * (20260613120000) that classifies canonical_cards.jp_refresh_tier from
 * Snkrdunk/Yahoo liquidity + page views, driving the JP scrape-cadence
 * RPCs. Separate column because the EN tier is Scrydex-density-based and
 * feeds EN-only consumers (movers warm-threshold, dormant-set fetch
 * planner, /data page). Sequential, not parallel: both UPDATE
 * canonical_cards (different columns, same rows), and concurrent row
 * locks would invite deadlocks for zero latency win on a weekly job.
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

  const en = await supabase.rpc("apply_refresh_tier_recompute");
  const jp = await supabase.rpc("apply_jp_refresh_tier_recompute");

  // Either failure is a real failure — a stale tier column silently degrades
  // the scrape cadence that depends on it (the silent-fallback shape that has
  // bitten this codebase before; see docs/external-api-failure-modes.md).
  if (en.error || jp.error) {
    const error = [
      en.error ? `en: ${en.error.message}` : null,
      jp.error ? `jp: ${jp.error.message}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    console.error("[cron/recompute-refresh-tier] failed:", error);
    return NextResponse.json(
      { ok: false, error, enResult: en.data ?? null, jpResult: jp.data ?? null },
      { status: 500 },
    );
  }

  const durationMs = Date.now() - startedAt;
  console.log("[cron/recompute-refresh-tier] done", {
    durationMs,
    result: en.data,
    jpResult: jp.data,
  });

  return NextResponse.json({ ok: true, durationMs, result: en.data, jpResult: jp.data });
}
