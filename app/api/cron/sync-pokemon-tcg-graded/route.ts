/**
 * Cron: sync-pokemon-tcg-graded
 *
 * Runs nightly at 8:30am UTC. Fetches graded card prices (PSA, BGS, CGC)
 * from the Pokemon TCG API (RapidAPI/Cardmarket) and writes to our
 * price infrastructure:
 *
 *   price_snapshots        — current graded price (upsert by provider_ref)
 *   price_history_points   — daily price point per variant_ref
 *   variant_metrics        — grade-specific analytics row
 *
 * Cursor-based set iteration from provider_set_map (POKEMON_TCG_API).
 * Processes 50 sets per run → cycles all ~174 sets every ~4 days.
 * Calls refresh_card_metrics() at end so graded rows appear in card_metrics.
 *
 * Rate budget: ~400 requests/run, well within 15K/day Ultra tier.
 *
 * Debug params:
 *   ?set={episodeId}   — process single set (skips cursor)
 *   ?force=1           — bypass idempotency check
 *   ?limit={n}         — max sets per run (default 50)
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { buildGradedVariantRef } from "@/lib/identity/variant-ref";
import { dbAdmin } from "@/lib/db/admin";
import {
  fetchAllEpisodeCards,
  extractGradedPrices,
  normalizeCardNumber,
  buildProviderRef,
  type PtcgApiCard,
  type ExtractedGradedPrice,
} from "@/lib/providers/pokemon-tcg-api";

export const runtime = "nodejs";
export const maxDuration = 300;

const PROVIDER = "POKEMON_TCG_API";
const JOB = "pokemon_tcg_graded_sync";
const SETS_PER_RUN = 50;
const BATCH_SIZE = 250;

// ── Batch helpers ────────────────────────────────────────────────────────────

async function batchUpsert<T extends Record<string, unknown>>(
  supabase: ReturnType<typeof dbAdmin>,
  table: string,
  rows: T[],
  onConflict: string,
  batchSize = BATCH_SIZE,
): Promise<{ upserted: number; failed: number; firstError: string | null }> {
  let upserted = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      failed += batch.length;
      if (!firstError) firstError = `${table}: ${error.message}`;
    } else {
      upserted += batch.length;
    }
  }

  return { upserted, failed, firstError };
}

// ── Types ────────────────────────────────────────────────────────────────────

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string | null;
  finish: string;
};

// ── Main handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const debugSet = url.searchParams.get("set")?.trim() ?? null;
  const force = url.searchParams.get("force") === "1";
  const maxSets = parseInt(url.searchParams.get("limit") ?? "0", 10) || SETS_PER_RUN;
  const isDebug = !!debugSet;

  const supabase = dbAdmin();
  const now = new Date().toISOString();

  // Idempotency check
  if (!force && !isDebug) {
    const todayStart = `${now.slice(0, 10)}T00:00:00Z`;
    const todayEnd = `${now.slice(0, 10)}T23:59:59Z`;
    const { data: existing } = await supabase
      .from("ingest_runs")
      .select("id")
      .eq("job", JOB)
      .eq("status", "finished")
      .eq("ok", true)
      .gte("ended_at", todayStart)
      .lte("ended_at", todayEnd)
      .limit(1)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already_ran_today" });
    }
  }

  // Create ingest run
  const { data: runRow } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: PROVIDER.toLowerCase(),
      status: "started",
      ok: false,
      started_at: now,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: { mode: isDebug ? "debug" : "cron", maxSets, force },
    })
    .select("id")
    .single();
  const runId = runRow?.id ?? null;

  let totalFetched = 0;
  let totalUpserted = 0;
  let totalFailed = 0;
  let totalHistoryPoints = 0;
  let totalVariantMetrics = 0;
  let setsProcessed = 0;
  let firstError: string | null = null;

  try {
    // Determine which sets to process
    let setsToProcess: Array<{
      canonical_set_code: string;
      canonical_set_name: string;
      provider_set_id: string;
    }> = [];

    if (isDebug) {
      setsToProcess = [{
        canonical_set_code: debugSet,
        canonical_set_name: debugSet,
        provider_set_id: debugSet,
      }];
    } else {
      // Cursor-based pagination from last successful run
      const { data: cursor } = await supabase
        .from("ingest_runs")
        .select("meta")
        .eq("job", JOB)
        .eq("status", "finished")
        .eq("ok", true)
        .order("ended_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const lastSetCode = (cursor?.meta as Record<string, unknown>)?.lastSetCode as string | undefined;

      let query = supabase
        .from("provider_set_map")
        .select("canonical_set_code, canonical_set_name, provider_set_id")
        .eq("provider", PROVIDER)
        .gt("confidence", 0)
        .order("canonical_set_code", { ascending: true })
        .limit(maxSets);

      if (lastSetCode) {
        query = query.gt("canonical_set_code", lastSetCode);
      }

      const { data: mapRows, error: mapError } = await query;
      if (mapError) throw new Error(`provider_set_map: ${mapError.message}`);
      setsToProcess = mapRows ?? [];

      // Wrap around if no more sets
      if (setsToProcess.length === 0 && lastSetCode) {
        const { data: wrapRows } = await supabase
          .from("provider_set_map")
          .select("canonical_set_code, canonical_set_name, provider_set_id")
          .eq("provider", PROVIDER)
          .gt("confidence", 0)
          .order("canonical_set_code", { ascending: true })
          .limit(maxSets);
        setsToProcess = wrapRows ?? [];
      }
    }

    // Process each set
    for (const setRow of setsToProcess) {
      try {
        const result = await processSet(
          supabase,
          setRow.canonical_set_code,
          setRow.provider_set_id,
          runId,
          now,
        );

        totalFetched += result.fetched;
        totalUpserted += result.upserted;
        totalFailed += result.failed;
        totalHistoryPoints += result.historyPoints;
        totalVariantMetrics += result.variantMetrics;
        setsProcessed++;

        if (result.error && !firstError) firstError = result.error;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = msg;
        totalFailed++;
      }
    }

    // Refresh card_metrics so graded rows appear
    let metricsRefreshResult: unknown = null;
    if (totalUpserted > 0) {
      const { data, error } = await supabase.rpc("refresh_card_metrics");
      metricsRefreshResult = error ? { error: error.message } : { rowsUpdated: data };
    }

    // Update ingest run
    const lastSetCode = setsToProcess.length > 0
      ? setsToProcess[setsToProcess.length - 1].canonical_set_code
      : null;

    if (runId) {
      await supabase
        .from("ingest_runs")
        .update({
          status: "finished",
          ok: !firstError || totalUpserted > 0,
          ended_at: new Date().toISOString(),
          items_fetched: totalFetched,
          items_upserted: totalUpserted,
          items_failed: totalFailed,
          meta: {
            lastSetCode,
            setsProcessed,
            totalHistoryPoints,
            totalVariantMetrics,
            metricsRefreshResult,
          },
        })
        .eq("id", runId);
    }

    return NextResponse.json({
      ok: !firstError || totalUpserted > 0,
      isDebug,
      setsProcessed,
      totalFetched,
      totalUpserted,
      totalFailed,
      totalHistoryPoints,
      totalVariantMetrics,
      metricsRefreshResult,
      firstError,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (runId) {
      await supabase
        .from("ingest_runs")
        .update({
          status: "finished",
          ok: false,
          ended_at: new Date().toISOString(),
          meta: { error: msg },
        })
        .eq("id", runId);
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ── Process a single set ─────────────────────────────────────────────────────

async function processSet(
  supabase: ReturnType<typeof dbAdmin>,
  setCode: string,
  providerSetId: string,
  runId: string | null,
  asOfTs: string,
): Promise<{
  fetched: number;
  upserted: number;
  failed: number;
  historyPoints: number;
  variantMetrics: number;
  error: string | null;
}> {
  const episodeId = parseInt(providerSetId, 10);
  if (!Number.isFinite(episodeId)) {
    return { fetched: 0, upserted: 0, failed: 0, historyPoints: 0, variantMetrics: 0, error: `Invalid episode ID: ${providerSetId}` };
  }

  // Fetch all cards from the API for this set
  const allCards = await fetchAllEpisodeCards(episodeId);
  if (allCards.length === 0) {
    return { fetched: 0, upserted: 0, failed: 0, historyPoints: 0, variantMetrics: 0, error: null };
  }

  // Load canonical printings for this set
  const { data: printings, error: printingsError } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, card_number, finish")
    .eq("set_code", setCode)
    .eq("language", "EN")
    .limit(5000);

  if (printingsError) {
    return { fetched: allCards.length, upserted: 0, failed: 0, historyPoints: 0, variantMetrics: 0, error: printingsError.message };
  }

  // Index printings by normalized card number
  const printingsByNumber = new Map<string, PrintingRow[]>();
  for (const p of (printings ?? []) as PrintingRow[]) {
    const num = normalizeCardNumber(p.card_number);
    if (!num) continue;
    const existing = printingsByNumber.get(num) ?? [];
    existing.push(p);
    printingsByNumber.set(num, existing);
  }

  // Build write batches
  const priceSnapshotRows: Record<string, unknown>[] = [];
  const historyRows: Record<string, unknown>[] = [];
  const variantMetricRows: Record<string, unknown>[] = [];

  for (const card of allCards) {
    const gradedPrices = extractGradedPrices(card);
    if (gradedPrices.length === 0) continue;

    // Match to our printing by card_number
    const cardNum = normalizeCardNumber(card.card_number);
    const candidates = printingsByNumber.get(cardNum);
    if (!candidates || candidates.length === 0) continue;

    // Use first matching printing (best by card number)
    const printing = candidates[0];

    for (const gp of gradedPrices) {
      writeGradedPrice({
        card,
        printing,
        gp,
        asOfTs,
        runId,
        priceSnapshotRows,
        historyRows,
        variantMetricRows,
      });
    }
  }

  // Write batches to DB
  let totalUpserted = 0;
  let totalFailed = 0;
  let error: string | null = null;

  if (priceSnapshotRows.length > 0) {
    const r = await batchUpsert(supabase, "price_snapshots", priceSnapshotRows, "provider_ref");
    totalUpserted += r.upserted;
    totalFailed += r.failed;
    if (r.firstError && !error) error = r.firstError;
  }

  let historyWritten = 0;
  if (historyRows.length > 0) {
    const r = await batchUpsert(
      supabase,
      "price_history_points",
      historyRows,
      "canonical_slug,variant_ref,provider,ts,source_window",
    );
    historyWritten = r.upserted;
    if (r.firstError && !error) error = r.firstError;
  }

  let metricsWritten = 0;
  if (variantMetricRows.length > 0) {
    const r = await batchUpsert(
      supabase,
      "variant_metrics",
      variantMetricRows,
      "canonical_slug,variant_ref,provider,grade",
    );
    metricsWritten = r.upserted;
    if (r.firstError && !error) error = r.firstError;
  }

  return {
    fetched: allCards.length,
    upserted: totalUpserted,
    failed: totalFailed,
    historyPoints: historyWritten,
    variantMetrics: metricsWritten,
    error,
  };
}

// ── Write a single graded price ──────────────────────────────────────────────

function writeGradedPrice(params: {
  card: PtcgApiCard;
  printing: PrintingRow;
  gp: ExtractedGradedPrice;
  asOfTs: string;
  runId: string | null;
  priceSnapshotRows: Record<string, unknown>[];
  historyRows: Record<string, unknown>[];
  variantMetricRows: Record<string, unknown>[];
}) {
  const { card, printing, gp, asOfTs, runId, priceSnapshotRows, historyRows, variantMetricRows } = params;

  const providerRef = buildProviderRef(card.id, gp.provider, gp.grade);
  const variantRef = buildGradedVariantRef(printing.id, gp.provider, gp.grade);

  // price_snapshots
  priceSnapshotRows.push({
    canonical_slug: printing.canonical_slug,
    printing_id: printing.id,
    grade: gp.grade,
    price_value: gp.price,
    currency: "EUR",
    provider: PROVIDER,
    provider_ref: providerRef,
    ingest_id: runId,
    observed_at: asOfTs,
  });

  // price_history_points — one point per day per variant
  historyRows.push({
    canonical_slug: printing.canonical_slug,
    variant_ref: variantRef,
    provider: PROVIDER,
    ts: asOfTs,
    price: gp.price,
    currency: "EUR",
    source_window: "snapshot",
  });

  // variant_metrics
  variantMetricRows.push({
    canonical_slug: printing.canonical_slug,
    printing_id: printing.id,
    variant_ref: variantRef,
    provider: PROVIDER,
    grade: gp.grade,
    provider_trend_slope_7d: null,
    provider_cov_price_30d: null,
    provider_price_relative_to_30d_range: null,
    provider_price_changes_count_30d: null,
    provider_as_of_ts: asOfTs,
    history_points_30d: 0,
    signal_trend: null,
    signal_breakout: null,
    signal_value: null,
    signals_as_of_ts: null,
    updated_at: asOfTs,
  });
}
