/**
 * Cron: prune-old-data
 *
 * Nightly cleanup of append-only tables that grow without bounds.
 * Calls the prune_old_data() SQL function which deletes rows beyond
 * their retention windows in 5 000-row chunks to keep transactions short.
 *
 * Schedule (vercel.json): 40 3 * * * — daily at 3:40 AM, off-peak.
 *
 * Tables pruned:
 *   provider_raw_payloads (14d), provider_ingests (30d),
 *   provider_normalized_observations (14d), listing_observations (14d),
 *   card_page_views (90d), price_snapshots (45d), price_history_points (90d).
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startMs = Date.now();
  const supabase = dbAdmin();

  const { data, error } = await supabase.rpc("prune_old_data");

  if (error) {
    console.error("[cron/prune-old-data] failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const durationMs = Date.now() - startMs;
  console.log("[cron/prune-old-data] done", { durationMs, result: data });

  return NextResponse.json({ ok: true, durationMs, pruned: data });
}
