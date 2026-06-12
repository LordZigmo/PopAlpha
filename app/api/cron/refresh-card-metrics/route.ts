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

  let result: unknown = null;
  let resultError: string | null = null;
  try {
    const { data, error } = await supabase.rpc("refresh_card_metrics");
    if (error) resultError = error.message;
    else result = data;
  } catch (err) {
    resultError = err instanceof Error ? err.message : String(err);
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

  // JP display liveness probe. The metrics GC exempts rows bearing
  // jp_display_price (20260613220000), so a dead refresh-jp-price-display
  // cron leaves stale JP prices visible indefinitely. The weekly
  // check-jp-source-divergence carries the same check for operator context,
  // but weekly detection of a 48h condition is up to a 9-day blind spot
  // (Codex P2 on the tiered-display PR) — THIS route's 12h cadence is the
  // primary alarm. jp_display_price_as_of has exactly one writer (the
  // display cron), so the global max is the liveness signal; no language
  // join needed.
  const JP_DISPLAY_STALE_HOURS = 48;
  let jpDisplayStalenessError: string | null = null;
  try {
    const { data: liveRows, error: liveErr } = await supabase
      .from("card_metrics")
      .select("jp_display_price_as_of")
      .not("jp_display_price_as_of", "is", null)
      .order("jp_display_price_as_of", { ascending: false })
      .limit(1);
    if (liveErr) {
      jpDisplayStalenessError = `probe failed: ${liveErr.message}`;
    } else {
      const newest = liveRows?.[0]?.jp_display_price_as_of as string | undefined;
      const ageHours = newest
        ? (Date.now() - new Date(newest).getTime()) / 3_600_000
        : Number.POSITIVE_INFINITY;
      if (ageHours > JP_DISPLAY_STALE_HOURS) {
        jpDisplayStalenessError = newest
          ? `newest jp_display_price_as_of is ${Math.round(ageHours)}h old (threshold ${JP_DISPLAY_STALE_HOURS}h) — is refresh-jp-price-display running?`
          : "no jp_display_price_as_of rows at all — is refresh-jp-price-display running?";
      }
    }
  } catch (err) {
    jpDisplayStalenessError = err instanceof Error ? err.message : String(err);
  }

  const stepErrors = [
    resultError ? `refreshCardMetrics: ${resultError}` : null,
    confidenceError ? `confidence: ${confidenceError}` : null,
    realizedBacktestError ? `realizedBacktest: ${realizedBacktestError}` : null,
    priceChangesError ? `priceChanges: ${priceChangesError}` : null,
    jpPriceChangesError ? `jpPriceChanges: ${jpPriceChangesError}` : null,
    jpDisplayStalenessError ? `jpDisplayStaleness: ${jpDisplayStalenessError}` : null,
  ].filter((e): e is string => e !== null);

  if (stepErrors.length > 0) {
    console.error("[cron/refresh-card-metrics] step failures:", stepErrors.join("; "));
  }

  return NextResponse.json(
    {
      ok: stepErrors.length === 0,
      result,
      resultError,
      confidence: confidenceResult,
      confidenceError,
      realizedBacktest: realizedBacktestResult,
      realizedBacktestError,
      priceChanges: priceChangesResult,
      priceChangesError,
      jpPriceChanges: jpPriceChangesResult,
      jpDisplayStalenessError,
      jpPriceChangesError,
    },
    { status: stepErrors.length > 0 ? 500 : 200 },
  );
}
