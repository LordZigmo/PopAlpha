/**
 * Cron: refresh-card-metrics
 *
 * Calls refresh_card_metrics() to recompute the card_metrics analytics table
 * from the unified price source (price_snapshots + legacy listing_observations).
 *
 * This is also called inline at the end of sync-justtcg-prices, so this
 * standalone endpoint is useful for ad-hoc refreshes or if other providers
 * are added with their own schedules.
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
  const { data, error } = await supabase.rpc("refresh_card_metrics");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, result: data });
}
