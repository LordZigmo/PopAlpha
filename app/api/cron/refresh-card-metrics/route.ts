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

  // refresh_price_changes() — compute 24h/7d change percentages from price_history_points
  let priceChangesResult: unknown = null;
  let priceChangesError: string | null = null;
  try {
    const { data: pcData, error: pcError } = await supabase.rpc("refresh_price_changes");
    if (pcError) {
      priceChangesError = pcError.message;
    } else {
      priceChangesResult = pcData;
    }
  } catch (err) {
    priceChangesError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({ ok: true, result: data, priceChanges: priceChangesResult, priceChangesError });
}
