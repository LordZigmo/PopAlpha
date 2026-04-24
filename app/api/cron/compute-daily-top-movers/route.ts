/**
 * Cron: compute-daily-top-movers
 *
 * Computes the day's top gainers and top losers ONCE PER DAY, storing
 * them in the daily_top_movers table for the homepage to read.
 *
 * Behavior:
 *   1. If today's rows already exist, skip (user: "generated once daily").
 *   2. Otherwise call compute_daily_top_movers RPC.
 *   3. RPC has a coverage gate — if catalog-wide fresh_24h count < 18k,
 *      it returns without writing. Cron quietly logs "waiting" and will
 *      retry on the next tick (every 2 hours).
 *
 * Schedule: 0 14,17,21 * * * (14:00 UTC = 9am EST, with retries at
 * 17:00 UTC and 21:00 UTC). The 9am EST primary attempt gives a stable
 * morning refresh. If the catalog coverage gate (18k fresh_24h cards)
 * isn't met yet because the morning Scrydex chunks haven't landed, the
 * 17:00 UTC retry picks it up mid-afternoon, and the 21:00 UTC fallback
 * is positioned after the day's final Scrydex chunk (18:50 UTC) so
 * coverage is guaranteed to be met by then.
 *
 * Manual override: query-string ?force=1 skips the "already computed"
 * check and re-computes even if today's rows exist. Useful for debugging.
 *
 * The homepage reads from daily_top_movers directly — see
 * lib/data/homepage.ts. If today's row doesn't exist yet, the homepage
 * falls back to yesterday's row so the rail isn't empty during the
 * morning window before coverage is met.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const startedAt = Date.now();
  const supabase = dbAdmin();

  // Skip if today's rows already exist (unless forced). The RPC itself is
  // idempotent — replaces today's rows — but we want "once daily" semantics
  // so the homepage list is stable once computed.
  if (!force) {
    const today = new Date().toISOString().slice(0, 10); // UTC
    const { count, error: countError } = await supabase
      .from("daily_top_movers")
      .select("computed_at_date", { count: "exact", head: true })
      .eq("computed_at_date", today);

    if (countError) {
      console.error(
        "[cron/compute-daily-top-movers] existing-check failed:",
        countError.message,
      );
      return NextResponse.json(
        { ok: false, error: countError.message },
        { status: 500 },
      );
    }

    if ((count ?? 0) > 0) {
      console.log("[cron/compute-daily-top-movers] already computed for today", {
        date: today,
        existingRows: count,
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "already_computed",
        computed_at_date: today,
        existing_rows: count,
      });
    }
  }

  const { data, error } = await supabase.rpc("compute_daily_top_movers");

  if (error) {
    console.error("[cron/compute-daily-top-movers] failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const durationMs = Date.now() - startedAt;
  console.log("[cron/compute-daily-top-movers] done", { durationMs, result: data });

  return NextResponse.json({ ok: true, durationMs, result: data });
}
