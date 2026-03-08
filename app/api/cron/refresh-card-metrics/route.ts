/**
 * Cron: refresh-card-metrics
 *
 * Calls the full refresh-card-metrics sweep.
 *
 * Provider pipelines now refresh touched cards inline with targeted rollups;
 * this endpoint remains the periodic full-dataset backstop.
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

  let confidenceResult: unknown = null;
  let confidenceError: string | null = null;
  try {
    const { data: confData, error: confErr } = await supabase.rpc("refresh_card_market_confidence");
    if (confErr) confidenceError = confErr.message;
    else confidenceResult = confData;
  } catch (err) {
    confidenceError = err instanceof Error ? err.message : String(err);
  }

  let realizedBacktestResult: unknown = null;
  let realizedBacktestError: string | null = null;
  try {
    const { data: btData, error: btErr } = await supabase.rpc("refresh_realized_sales_backtest");
    if (btErr) realizedBacktestError = btErr.message;
    else realizedBacktestResult = btData;
  } catch (err) {
    realizedBacktestError = err instanceof Error ? err.message : String(err);
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

  return NextResponse.json({
    ok: true,
    result: data,
    confidence: confidenceResult,
    confidenceError,
    realizedBacktest: realizedBacktestResult,
    realizedBacktestError,
    priceChanges: priceChangesResult,
    priceChangesError,
  });
}
