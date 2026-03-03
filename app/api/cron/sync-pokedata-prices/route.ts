/**
 * Cron: sync-pokedata-prices
 *
 * Syncs Pokemon card prices from Pokedata.io into price_snapshots,
 * price_history_points, and variant_metrics.
 *
 * Runs daily at 6:30am UTC (offset from JustTCG at 6am to avoid overlap).
 * Iterates sets via cursor in provider_set_map (POKEDATA provider).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>.
 *
 * Query params:
 *   ?set={providerSetId}  — debug: process single set
 *   ?force=1              — bypass idempotency check
 *   ?limit={n}            — max sets per run (default 50)
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { buildRawVariantRef } from "@/lib/identity/variant-ref";
import { dbAdmin } from "@/lib/db/admin";
import {
  fetchPokedataCardsPage,
  mapPokedataPrinting,
  normalizeCardNumber,
  normalizeCondition,
  normalizeLanguage,
  mapVariantToMetrics,
  mapVariantToHistoryPoints,
  type PokedataCard,
  type PokedataVariant,
} from "@/lib/providers/pokedata";

export const runtime = "nodejs";
export const maxDuration = 300;

const PROVIDER = "POKEDATA";
const JOB = "pokedata_price_sync";
const SETS_PER_RUN = 50;
const BATCH_SIZE = 250;

// ── Batch upsert helper ─────────────────────────────────────────────────────

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
      provider: PROVIDER,
      status: "started",
      ok: false,
      started_at: now,
    })
    .select("id")
    .single();
  const runId = runRow?.id ?? null;

  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;
  let historyPointsWritten = 0;
  let variantMetricsWritten = 0;
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
      // Debug: single set
      setsToProcess = [
        {
          canonical_set_code: debugSet,
          canonical_set_name: debugSet,
          provider_set_id: debugSet,
        },
      ];
    } else {
      // Load from provider_set_map with cursor-based pagination
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
        const setResult = await processSet(
          supabase,
          setRow.canonical_set_code,
          setRow.canonical_set_name,
          setRow.provider_set_id,
          runId,
          now,
        );

        itemsFetched += setResult.fetched;
        itemsUpserted += setResult.upserted;
        itemsFailed += setResult.failed;
        historyPointsWritten += setResult.historyPoints;
        variantMetricsWritten += setResult.variantMetrics;
        setsProcessed++;

        if (setResult.error && !firstError) {
          firstError = setResult.error;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = msg;
        itemsFailed++;
      }
    }

    // Refresh card_metrics after sync
    let metricsRefreshResult: unknown = null;
    if (itemsUpserted > 0) {
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
          ok: !firstError || itemsUpserted > 0,
          ended_at: new Date().toISOString(),
          items_fetched: itemsFetched,
          items_upserted: itemsUpserted,
          items_failed: itemsFailed,
          meta: { lastSetCode, setsProcessed, historyPointsWritten, variantMetricsWritten },
        })
        .eq("id", runId);
    }

    return NextResponse.json({
      ok: !firstError || itemsUpserted > 0,
      isDebug,
      setsProcessed,
      itemsFetched,
      itemsUpserted,
      itemsFailed,
      historyPointsWritten,
      variantMetricsWritten,
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
  setName: string,
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
  // Fetch all cards from Pokedata for this set
  const allCards: PokedataCard[] = [];
  let offset = 0;
  const limit = 100;
  const maxPages = 50;
  let pages = 0;

  while (pages < maxPages) {
    const { cards, hasMore, httpStatus } = await fetchPokedataCardsPage(providerSetId, {
      limit,
      offset,
    });
    if (httpStatus === 429) {
      return { fetched: allCards.length, upserted: 0, failed: 0, historyPoints: 0, variantMetrics: 0, error: "Rate limited (429)" };
    }
    if (httpStatus < 200 || httpStatus >= 300) break;
    allCards.push(...cards);
    pages++;
    if (!hasMore || cards.length === 0) break;
    offset += limit;
  }

  if (allCards.length === 0) {
    return { fetched: 0, upserted: 0, failed: 0, historyPoints: 0, variantMetrics: 0, error: null };
  }

  // Load canonical printings for this set
  const { data: printings, error: printingsError } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, card_number, finish, language, set_code")
    .eq("set_code", setCode)
    .eq("language", "EN")
    .limit(5000);

  if (printingsError) {
    return { fetched: allCards.length, upserted: 0, failed: 0, historyPoints: 0, variantMetrics: 0, error: printingsError.message };
  }

  // Index printings by normalized card number
  const printingsByNumber = new Map<string, typeof printings>();
  for (const p of printings ?? []) {
    const num = normalizeCardNumber(p.card_number ?? "");
    if (!num) continue;
    const existing = printingsByNumber.get(num) ?? [];
    existing.push(p);
    printingsByNumber.set(num, existing);
  }

  // Match Pokedata cards to canonical printings and build write batches
  const priceSnapshotRows: Record<string, unknown>[] = [];
  const historyRows: Record<string, unknown>[] = [];
  const variantMetricRows: Record<string, unknown>[] = [];
  let matchedCount = 0;

  for (const card of allCards) {
    const cardNum = normalizeCardNumber(card.number);
    const candidates = printingsByNumber.get(cardNum);
    if (!candidates || candidates.length === 0) continue;

    // Pick best printing match (prefer matching finish)
    for (const variant of card.variants ?? []) {
      if (!variant.price || variant.price <= 0) continue;
      const condition = normalizeCondition(variant.condition ?? "");
      if (condition !== "nm") continue; // Only sync NM prices

      const language = normalizeLanguage(variant.language ?? "English");
      if (language !== "en") continue;

      const finish = mapPokedataPrinting(variant.printing ?? "");
      const printing = candidates[0]; // Best match by number

      const providerRef = `pokedata:${card.id}:${variant.id}`;
      const variantRef = buildRawVariantRef(printing.id);

      // Price snapshot
      priceSnapshotRows.push({
        canonical_slug: printing.canonical_slug,
        printing_id: printing.id,
        grade: "RAW",
        price_value: variant.price,
        currency: "USD",
        provider: PROVIDER,
        provider_ref: providerRef,
        ingest_id: runId,
        observed_at: asOfTs,
      });

      // History points
      const historyPoints = mapVariantToHistoryPoints(variant, printing.canonical_slug, variantRef);
      for (const pt of historyPoints) {
        historyRows.push(pt);
      }

      // Variant metrics
      const metrics = mapVariantToMetrics(variant, printing.canonical_slug, printing.id, "RAW", asOfTs);
      if (metrics) {
        variantMetricRows.push({
          canonical_slug: metrics.canonical_slug,
          variant_ref: variantRef,
          printing_id: metrics.printing_id,
          grade: metrics.grade,
          provider: PROVIDER,
          provider_as_of_ts: metrics.provider_as_of_ts,
          price_value: metrics.price_value,
          provider_trend_slope_7d: metrics.provider_trend_slope_7d,
          provider_trend_slope_30d: metrics.provider_trend_slope_30d,
          provider_cov_price_7d: metrics.provider_cov_price_7d,
          provider_cov_price_30d: metrics.provider_cov_price_30d,
          provider_price_relative_to_30d_range: metrics.provider_price_relative_to_30d_range,
          provider_price_changes_count_30d: metrics.provider_price_changes_count_30d,
          updated_at: asOfTs,
        });
      }

      matchedCount++;
      break; // One variant per card (NM English)
    }
  }

  // Write batches
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
