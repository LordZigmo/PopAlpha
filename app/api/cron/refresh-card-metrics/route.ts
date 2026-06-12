/**
 * Cron: refresh-card-metrics
 *
 * Calls the full refresh-card-metrics sweep.
 *
 * Provider pipelines now refresh touched cards inline with targeted rollups;
 * this endpoint remains the periodic full-dataset backstop.
 *
 * Failure contract: every step runs regardless of earlier step failures
 * (each is independent — maximum progress per tick), but ANY step failure
 * makes the response ok:false / 500 with the per-step errors in the body
 * and a console.error for log retention. A swallowed step error here is
 * the documented silent-fallback shape (docs/external-api-failure-modes.md;
 * 4th near-miss found 2026-06-11: jpPriceChangesError rode inside ok:true,
 * unlogged — a sustained JP populator outage would have rotted every JP
 * change badge with zero signal).
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

  // compute_jp_card_price_changes() — JP-native 24h/7d deltas from
  // jp_card_price_history for JP-language canonical-level RAW rows.
  // Mirrors the refresh_price_changes() shape. See migration
  // 20260520140000 for the design and freshness rollout timeline.
  let jpPriceChangesResult: unknown = null;
  let jpPriceChangesError: string | null = null;
  try {
    const { data: jpData, error: jpError } = await supabase.rpc("compute_jp_card_price_changes");
    if (jpError) {
      jpPriceChangesError = jpError.message;
    } else {
      jpPriceChangesResult = jpData;
    }
  } catch (err) {
    jpPriceChangesError = err instanceof Error ? err.message : String(err);
  }

  const stepErrors = [
    confidenceError ? `confidence: ${confidenceError}` : null,
    realizedBacktestError ? `realizedBacktest: ${realizedBacktestError}` : null,
    priceChangesError ? `priceChanges: ${priceChangesError}` : null,
    jpPriceChangesError ? `jpPriceChanges: ${jpPriceChangesError}` : null,
  ].filter((e): e is string => e !== null);

  if (stepErrors.length > 0) {
    console.error("[cron/refresh-card-metrics] step failures:", stepErrors.join("; "));
  }

  return NextResponse.json(
    {
      ok: stepErrors.length === 0,
      result: data,
      confidence: confidenceResult,
      confidenceError,
      realizedBacktest: realizedBacktestResult,
      realizedBacktestError,
      priceChanges: priceChangesResult,
      priceChangesError,
      jpPriceChanges: jpPriceChangesResult,
      jpPriceChangesError,
    },
    { status: stepErrors.length > 0 ? 500 : 200 },
  );
}
