/**
 * Cron: refresh-derived-signals
 *
 * Calls refresh_derived_signals() to compute PopAlpha branded signals
 * (Trend Strength, Breakout Score, Value Zone) from provider_* fields
 * already stored in card_metrics.
 *
 * Runs nightly at 8am UTC — after sync-justtcg-prices (6am) writes
 * provider_* fields and refresh_card_metrics() populates medians.
 *
 * Auth: Bearer CRON_SECRET or ?secret=CRON_SECRET query param.
 */

import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization")?.trim() ?? "";
    const url0 = new URL(req.url);
    const querySecret = url0.searchParams.get("secret")?.trim() ?? "";
    if (auth !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getServerSupabaseClient();

  try {
    const { data, error } = await supabase.rpc("refresh_derived_signals");
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, result: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
