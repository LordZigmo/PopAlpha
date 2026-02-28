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
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization")?.trim() ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getServerSupabaseClient();
  const { data, error } = await supabase.rpc("refresh_card_metrics");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, result: data });
}
