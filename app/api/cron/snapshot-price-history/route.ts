/**
 * Cron: snapshot-price-history
 *
 * Runs daily at 6am (after sync-tcg-prices at 5am) and calls the
 * snapshot_price_history() Postgres function, which reads the current
 * market_snapshot_rollups view and writes one price_history row per
 * card × printing × grade for today's date.
 *
 * Idempotent — safe to trigger manually at any time. Re-running on the
 * same day updates the snapshot with the latest prices.
 */

import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();

  const { data, error } = await supabase.rpc("snapshot_price_history");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ...((data as Record<string, unknown> | null) ?? {}), deprecatedQueryAuth: auth.deprecatedQueryAuth });
}
