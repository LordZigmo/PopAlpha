/**
 * Cron: snapshot-price-history
 *
 * Runs on a daily cadence and calls the snapshot_price_history() Postgres
 * function, which reads the current market_snapshot_rollups view and writes
 * one price_history row per card × printing × grade for today's date.
 *
 * Idempotent — safe to trigger manually at any time. Re-running on the
 * same day updates the snapshot with the latest prices.
 *
 * After the snapshot lands, refreshes the canonical_price_daily rollup that
 * powers the portfolio sparkline. This is the natural, credit-neutral host:
 * snapshot_price_history() is the upstream writer of the snapshot rows the
 * rollup reads, so refreshing here keeps the rollup within one tick of the
 * source with no extra provider calls. (downsample-price-history would be the
 * wrong host — it's a self-deleting backlog cleanup.)
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();

  const { data, error } = await supabase.rpc("snapshot_price_history");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Refresh the portfolio-sparkline rollup off the freshly-snapshotted rows.
  // Don't fail the cron if this errors — the snapshot itself already succeeded,
  // and a stale rollup only costs sparkline freshness (the route's live-price
  // append still anchors "today"). Surface the outcome in the response.
  const { data: rollup, error: rollupError } = await supabase.rpc(
    "refresh_canonical_price_daily",
    { p_canonical_slugs: null, p_days: 35 },
  );
  if (rollupError) {
    console.error("[snapshot-price-history] canonical_price_daily refresh failed:", rollupError.message);
  }

  return NextResponse.json({
    ...((data as Record<string, unknown> | null) ?? {}),
    canonical_price_daily: rollupError ? { ok: false, error: rollupError.message } : rollup,
  });
}
