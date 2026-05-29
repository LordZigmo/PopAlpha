/**
 * Cron: import-pricecharting
 *
 * Pulls the daily PriceCharting CSV export and refreshes the trustworthy
 * price rails. Without this the `canonical_trusted_raw_prices` table goes
 * stale and the public_card_metrics view fails closed — the symptom that
 * left the homepage showing only ~139 cards "priced within 24h" once the
 * manual CLI feed stopped.
 *
 * One daily schedule drives this route (see vercel.json), but the work
 * differs by day of week:
 *
 *   • MON–SAT: upsert products + observations, then run the
 *     trusted-raw-price parity RPC. NO matching. This keeps the ~14.8k
 *     already-matched cards freshly priced every day on a lean, fast path
 *     that comfortably fits the function ceiling.
 *
 *   • SUNDAY (UTC): the above PLUS canonical/printing matching, which scans
 *     the full EN catalog and links newly released PriceCharting products.
 *     Heavy and rarely-changing, so it runs once a week rather than burning
 *     ~minutes of catalog scan on every daily tick.
 *
 * The day-of-week split lives in the route (not a second cron entry with a
 * query string) so it doesn't depend on Vercel preserving cron-path query
 * params. `?match=1` / `?match=0` still force the behavior for manual ops.
 *
 * Query params (manual triggering / ops):
 *   • match=1          — force matching on any tick
 *   • match=0          — force-skip matching even on Sunday
 *   • refreshParity=0  — skip the parity RPC (debugging only)
 *
 * Config: PRICECHARTING_CSV_URL must be set in the environment (the signed
 * CSV download URL from the PriceCharting subscription). A missing URL is a
 * hard 500 — we never quietly write zero rows.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  fetchPriceChartingCsvRecords,
  runPriceChartingIngest,
} from "@/lib/backfill/pricecharting-ingest";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel function ceiling

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const csvUrl = process.env.PRICECHARTING_CSV_URL?.trim();
  if (!csvUrl) {
    const response = {
      ok: false,
      error: "PRICECHARTING_CSV_URL is not configured",
    };
    console.error("[import-pricecharting] summary", JSON.stringify(response));
    return NextResponse.json(response, { status: 500 });
  }

  const url = new URL(req.url);
  const matchParam = url.searchParams.get("match");
  // Mon–Sat just re-price already-matched cards (lean). Sunday (UTC) also
  // re-matches the full catalog to pick up newly released products.
  const shouldMatch = matchParam === "1"
    || (matchParam !== "0" && new Date().getUTCDay() === 0);
  const refreshParity = url.searchParams.get("refreshParity") !== "0";

  const startedAt = Date.now();
  try {
    const records = await fetchPriceChartingCsvRecords(csvUrl);
    const summary = await runPriceChartingIngest({
      supabase: dbAdmin(),
      records,
      importSource: "csv",
      match: shouldMatch,
      refreshParity,
    });
    const elapsedMs = Date.now() - startedAt;
    const response = { ...summary, elapsedMs, elapsedSec: Math.round(elapsedMs / 1000) };
    console.info("[import-pricecharting] summary", JSON.stringify(response));
    return NextResponse.json(response);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const response = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs,
    };
    console.error("[import-pricecharting] summary", JSON.stringify(response));
    return NextResponse.json(response, { status: 500 });
  }
}
