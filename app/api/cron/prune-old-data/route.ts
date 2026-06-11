/**
 * Cron: prune-old-data
 *
 * Nightly cleanup of append-only tables that grow without bounds.
 * Calls the prune_old_data() SQL function, which loops chunked deletes
 * per table until caught up, a per-table loop cap (?loops=, default 10
 * × 10k rows) is hit, or its internal ~95s clock budget runs out —
 * transactions stay short while backlogged tables actually drain.
 *
 * Schedule (vercel.json): 40 3 * * * — daily at 3:40 AM, off-peak.
 *
 * Tables pruned:
 *   provider_raw_payloads (14d), provider_ingests (30d),
 *   provider_normalized_observations (14d), listing_observations (14d),
 *   card_page_views (90d), price_snapshots (45d),
 *   price_history_points (90d + 30d downsample),
 *   provider_price_history (180d), ingest_runs (30d).
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 120;

// Per-table chunk-loop cap forwarded to prune_old_data(). The default
// (10 loops × 10k rows) comfortably covers steady-state nights; pass
// ?loops=50 for manual catch-up passes against a backlog (the function's
// internal 95s clock budget still bounds each call). 2026-06-11: the old
// single-5k-chunk function fell ~32 GB behind on
// provider_normalized_observations — see the migration of the same date.
const DEFAULT_LOOPS = 10;
const MAX_LOOPS = 200;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startMs = Date.now();
  const supabase = dbAdmin();

  const loopsParam = Number.parseInt(new URL(req.url).searchParams.get("loops") ?? "", 10);
  const loops = Number.isInteger(loopsParam) && loopsParam > 0
    ? Math.min(loopsParam, MAX_LOOPS)
    : DEFAULT_LOOPS;

  const { data, error } = await supabase.rpc("prune_old_data", {
    _max_loops_per_table: loops,
  });

  if (error) {
    console.error("[cron/prune-old-data] failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const durationMs = Date.now() - startMs;
  console.log("[cron/prune-old-data] done", { durationMs, loops, result: data });

  return NextResponse.json({ ok: true, durationMs, loops, pruned: data });
}
