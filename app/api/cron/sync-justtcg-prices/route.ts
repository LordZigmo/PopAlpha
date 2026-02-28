/**
 * Cron: sync-justtcg-prices
 *
 * Runs nightly at 6am UTC (≈1am EST). Fetches Pokemon card prices from
 * JustTCG Enterprise and writes to our 3-layer price architecture:
 *
 *   Layer 1 — provider audit:
 *     provider_raw_payloads  full /cards response per set
 *     provider_ingests       one row per matched card variant
 *     provider_set_map       set ID confidence tracking
 *
 *   Layer 2 — canonical storage:
 *     price_snapshots        current NM price (upsert by provider_ref)
 *     price_history_points   priceHistory30d time series (ON CONFLICT DO NOTHING)
 *
 *   Layer 3 — analytics:
 *     card_metrics           refresh_card_metrics() then provider field upsert
 *
 * Set discovery:
 *   /sets?game=pokemon is broken on JustTCG. We derive set IDs from our own
 *   card_printings.set_name using setNameToJustTcgId() and verify by whether
 *   cards are returned. Confidence is tracked in provider_set_map.
 *
 * Debug mode (single set, no cursor):
 *   GET /api/cron/sync-justtcg-prices?set=base-set-pokemon&limit=1
 *
 * Rate limits (Enterprise): 500K/month · 50K/day · 500/min
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  fetchJustTcgCards,
  setNameToJustTcgId,
  mapJustTcgPrinting,
  normalizeCardNumber,
  mapVariantToMetrics,
  mapVariantToHistoryPoints,
  buildVariantRef,
  type JustTcgCard,
} from "@/lib/providers/justtcg";
import type { MetricsSnapshot, PriceHistoryPoint } from "@/lib/providers/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOB = "justtcg_price_sync";
const PROVIDER = "JUSTTCG";

// How many sets to process per run. Override via env var for testing.
const SETS_PER_RUN = process.env.JUSTTCG_SETS_PER_RUN
  ? parseInt(process.env.JUSTTCG_SETS_PER_RUN, 10)
  : 100;

// ── Types ──────────────────────────────────────────────────────────────────────

type OurSet = { setCode: string; setName: string };

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string | null;
  finish: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function requestHash(provider: string, endpoint: string, params: Record<string, unknown>): string {
  const str = JSON.stringify({ provider, endpoint, params });
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

async function batchUpsert<T extends Record<string, unknown>>(
  supabase: ReturnType<typeof getServerSupabaseClient>,
  table: string,
  rows: T[],
  onConflict: string,
  batchSize = 250,
): Promise<{ upserted: number; failed: number; firstError: string | null }> {
  let upserted = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      firstError ??= `${table}: ${error.message}`;
      failed += batch.length;
    } else {
      upserted += batch.length;
    }
  }
  return { upserted, failed, firstError };
}

async function batchInsertIgnore<T extends Record<string, unknown>>(
  supabase: ReturnType<typeof getServerSupabaseClient>,
  table: string,
  rows: T[],
  onConflict: string,
  batchSize = 500,
): Promise<{ inserted: number; firstError: string | null }> {
  let inserted = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: true });
    if (error) {
      firstError ??= `${table}: ${error.message}`;
    } else {
      inserted += batch.length;
    }
  }
  return { inserted, firstError };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization")?.trim() ?? "";
    // Allow both Vercel cron (Bearer) and direct debug requests (?secret=...)
    const url = new URL(req.url);
    const querySecret = url.searchParams.get("secret")?.trim() ?? "";
    if (auth !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const debugSet = url.searchParams.get("set")?.trim() ?? null;   // e.g. "base-set-pokemon"
  const debugLimit = parseInt(url.searchParams.get("limit") ?? "0", 10) || null;
  const isDebug = !!debugSet;

  const supabase = getServerSupabaseClient();
  const now = new Date().toISOString();
  const runDate = now.slice(0, 10); // YYYY-MM-DD

  // ── Idempotency: skip if a complete run already finished today ───────────────
  if (!isDebug) {
    const { data: todayRun } = await supabase
      .from("ingest_runs")
      .select("id")
      .eq("job", JOB)
      .eq("status", "finished")
      .eq("ok", true)
      .gte("ended_at", `${runDate}T00:00:00Z`)
      .lte("ended_at", `${runDate}T23:59:59Z`)
      // only skip if it was a full pass (done=true)
      .contains("meta", { done: true })
      .limit(1)
      .maybeSingle();
    if (todayRun) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already completed today" });
    }
  }

  // ── Cursor from last run ────────────────────────────────────────────────────
  const { data: lastRun } = await supabase
    .from("ingest_runs")
    .select("meta")
    .eq("job", JOB)
    .eq("status", "finished")
    .eq("ok", true)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ meta: Record<string, unknown> | null }>();

  const lastMeta = lastRun?.meta ?? null;
  const lastSetCode = typeof lastMeta?.nextSetCode === "string" ? lastMeta.nextSetCode : "";

  // ── Get our canonical English sets ─────────────────────────────────────────
  const { data: setsRaw } = await supabase
    .from("card_printings")
    .select("set_code, set_name")
    .eq("language", "EN")
    .not("set_code", "is", null)
    .not("set_name", "is", null)
    .limit(10000);

  const seenCodes = new Set<string>();
  const allSets: OurSet[] = [];
  for (const row of setsRaw ?? []) {
    if (row.set_code && row.set_name && !seenCodes.has(row.set_code)) {
      seenCodes.add(row.set_code);
      allSets.push({ setCode: row.set_code, setName: row.set_name });
    }
  }
  allSets.sort((a, b) => a.setCode.localeCompare(b.setCode));

  // In debug mode: only process the explicitly requested set.
  let setsToProcess: OurSet[];
  if (isDebug) {
    setsToProcess = allSets.length > 0 ? [allSets[0]] : []; // placeholder; overridden below
  } else {
    const remaining = lastSetCode ? allSets.filter((s) => s.setCode > lastSetCode) : allSets;
    setsToProcess = remaining.slice(0, SETS_PER_RUN);
  }

  const done = isDebug ? false : setsToProcess.length < SETS_PER_RUN;
  const nextSetCode = done ? "" : (setsToProcess.at(-1)?.setCode ?? "");

  // ── Load or derive provider_set_map entries ─────────────────────────────────
  const { data: existingMapRows } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, provider_set_id, confidence")
    .eq("provider", PROVIDER)
    .in("canonical_set_code", setsToProcess.map((s) => s.setCode));

  const setMapByCode = new Map<string, { provider_set_id: string; confidence: number }>();
  for (const row of existingMapRows ?? []) {
    setMapByCode.set(row.canonical_set_code, {
      provider_set_id: row.provider_set_id,
      confidence: row.confidence,
    });
  }

  // ── Start ingest run ────────────────────────────────────────────────────────
  const { data: runRow } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "justtcg",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: { lastSetCode, nextSetCode, setsCount: setsToProcess.length, done, isDebug },
    })
    .select("id")
    .single<{ id: string }>();
  const runId = runRow?.id ?? null;

  // ── Accumulators ────────────────────────────────────────────────────────────
  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;
  let firstError: string | null = null;

  const allPriceSnapshots: Record<string, unknown>[] = [];
  const allHistoryPoints: PriceHistoryPoint[] = [];
  const allMetricsSnapshots: MetricsSnapshot[] = [];
  const allIngestRows: Record<string, unknown>[] = [];
  const mapUpserts: Record<string, unknown>[] = [];
  // Debug mode: capture raw JustTCG envelopes to surface in response.
  const debugRawResponses: Array<{ providerSetId: string; httpStatus: number; envelope: unknown }> = [];

  // ── Process each set ────────────────────────────────────────────────────────
  for (const ourSet of setsToProcess) {
    // Resolve provider set ID.
    const existing = setMapByCode.get(ourSet.setCode);
    const providerSetId = isDebug
      ? debugSet!
      : (existing?.provider_set_id ?? setNameToJustTcgId(ourSet.setName));

    try {
      // 1. Fetch cards from JustTCG.
      const { cards, rawEnvelope, httpStatus } = await fetchJustTcgCards(providerSetId, 1);

      if (isDebug) debugRawResponses.push({ providerSetId, httpStatus, envelope: rawEnvelope });

      // 2. Store raw payload (one row per API call — INSERT only; skip if already stored today).
      const hash = requestHash(PROVIDER, "/cards", { set: providerSetId, page: 1, limit: 200 });
      const { error: rawErr } = await supabase.from("provider_raw_payloads").insert({
        provider: PROVIDER,
        endpoint: "/cards",
        params: { set: providerSetId, page: 1, limit: 200 },
        response: rawEnvelope ?? {},
        status_code: httpStatus,
        fetched_at: now,
        request_hash: hash,
        canonical_slug: null,
        variant_ref: null,
      });
      if (rawErr && !rawErr.message.includes("duplicate") && !rawErr.message.includes("unique")) {
        firstError ??= `provider_raw_payloads insert: ${rawErr.message}`;
      }

      // 3. Surface non-200 responses as errors so they appear in firstError.
      if (httpStatus < 200 || httpStatus >= 300) {
        firstError ??= `JustTCG ${httpStatus} for set ${providerSetId}: ${JSON.stringify(rawEnvelope).slice(0, 200)}`;
      }

      // 4. Update provider_set_map confidence.
      const hasCards = cards.length > 0;
      mapUpserts.push({
        provider: PROVIDER,
        canonical_set_code: ourSet.setCode,
        canonical_set_name: ourSet.setName,
        provider_set_id: providerSetId,
        confidence: hasCards ? 1.0 : 0.0,
        last_verified_at: hasCards ? now : null,
      });

      if (!hasCards) continue;

      // 5. Load our card_printings for this set (for card number matching).
      const { data: printingsRaw } = await supabase
        .from("card_printings")
        .select("id, canonical_slug, card_number, finish")
        .eq("set_code", ourSet.setCode)
        .eq("language", "EN")
        .not("canonical_slug", "is", null);

      const printings = (printingsRaw ?? []) as PrintingRow[];

      // Build lookup: normNum → finish → PrintingRow
      const byNumberAndFinish = new Map<string, Map<string, PrintingRow>>();
      const byNumber = new Map<string, PrintingRow>(); // fallback
      for (const p of printings) {
        if (!p.card_number || !p.canonical_slug) continue;
        const normNum = normalizeCardNumber(p.card_number);
        let finishMap = byNumberAndFinish.get(normNum);
        if (!finishMap) { finishMap = new Map(); byNumberAndFinish.set(normNum, finishMap); }
        finishMap.set(p.finish, p);
        if (!byNumber.has(normNum) || p.finish === "NON_HOLO") byNumber.set(normNum, p);
      }

      // Apply debug card limit if set.
      const cardsToProcess: JustTcgCard[] = debugLimit ? cards.slice(0, debugLimit) : cards;
      itemsFetched += cardsToProcess.length;

      // 6. Process each card's NM variants.
      for (const card of cardsToProcess) {
        const normNum = normalizeCardNumber(card.number);

        for (const variant of card.variants ?? []) {
          if (!variant.condition?.toLowerCase().includes("near mint")) continue;
          if (!variant.price || variant.price <= 0) continue;

          const mappedFinish = mapJustTcgPrinting(variant.printing ?? "");
          const finishMap = byNumberAndFinish.get(normNum);
          const printing = finishMap?.get(mappedFinish) ?? byNumber.get(normNum) ?? null;

          const asOfTs = variant.lastUpdated
            ? new Date(variant.lastUpdated * 1000).toISOString()
            : now;

          const variantRef = buildVariantRef(mappedFinish, variant.condition, "RAW");

          // Audit row (even if no printing match).
          allIngestRows.push({
            provider: PROVIDER,
            job: JOB,
            set_id: providerSetId,
            card_id: card.id,
            variant_id: variant.id,
            canonical_slug: printing?.canonical_slug ?? null,
            printing_id: printing?.id ?? null,
            raw_payload: {
              variantId: variant.id,
              cardId: card.id,
              setId: providerSetId,
              cardNumber: card.number,
              condition: variant.condition,
              printing: variant.printing,
              price: variant.price,
              trendSlope7d: variant.trendSlope7d ?? null,
              covPrice30d: variant.covPrice30d ?? null,
              priceRelativeTo30dRange: variant.priceRelativeTo30dRange ?? null,
              minPriceAllTime: variant.minPriceAllTime ?? null,
              maxPriceAllTime: variant.maxPriceAllTime ?? null,
              lastUpdated: variant.lastUpdated ?? null,
            },
          });

          if (!printing) continue;

          // price_snapshots (current NM price, upsert by provider_ref).
          allPriceSnapshots.push({
            canonical_slug: printing.canonical_slug,
            printing_id: printing.id,
            grade: "RAW",
            price_value: variant.price,
            currency: "USD",
            provider: PROVIDER,
            provider_ref: `justtcg-${variant.id}`,
            ingest_id: null,
            observed_at: asOfTs,
          });

          // price_history_points (from priceHistory30d).
          const historyPoints = mapVariantToHistoryPoints(
            variant,
            printing.canonical_slug,
            mappedFinish,
            "RAW",
          );
          allHistoryPoints.push(...historyPoints);

          // card_metrics provider fields.
          const metrics = mapVariantToMetrics(
            variant,
            printing.canonical_slug,
            printing.id,
            "RAW",
            asOfTs,
          );
          if (metrics) allMetricsSnapshots.push(metrics);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= `set ${ourSet.setCode}: ${msg}`;
      itemsFailed += 1;
    }
  }

  // ── Batch writes ─────────────────────────────────────────────────────────────

  // provider_set_map
  if (mapUpserts.length > 0) {
    await supabase
      .from("provider_set_map")
      .upsert(mapUpserts as Record<string, unknown>[], { onConflict: "provider,canonical_set_code" });
  }

  // provider_ingests
  if (allIngestRows.length > 0) {
    for (let i = 0; i < allIngestRows.length; i += 250) {
      await supabase.from("provider_ingests").insert(allIngestRows.slice(i, i + 250));
    }
  }

  // price_snapshots
  const snapResult = await batchUpsert(
    supabase,
    "price_snapshots",
    allPriceSnapshots as Record<string, unknown>[],
    "provider,provider_ref",
  );
  itemsUpserted += snapResult.upserted;
  itemsFailed += snapResult.failed;
  firstError ??= snapResult.firstError;

  // price_history_points (ON CONFLICT DO NOTHING — idempotent)
  const histResult = await batchInsertIgnore(
    supabase,
    "price_history_points",
    allHistoryPoints as unknown as Record<string, unknown>[],
    "canonical_slug,variant_ref,provider,ts",
  );
  firstError ??= histResult.firstError;

  // ── refresh_card_metrics() — compute stats from price_snapshots ──────────────
  let metricsRefreshResult: unknown = null;
  try {
    const { data } = await supabase.rpc("refresh_card_metrics");
    metricsRefreshResult = data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    firstError ??= `refresh_card_metrics: ${msg}`;
  }

  // ── Upsert provider-supplied fields to card_metrics (after refresh) ──────────
  // Only sets the provider_* columns — does NOT touch computed stats (median_7d etc.)
  const metricsRows = allMetricsSnapshots.map((m) => ({
    canonical_slug: m.canonical_slug,
    printing_id: m.printing_id,
    grade: m.grade,
    provider_trend_slope_7d: m.provider_trend_slope_7d,
    provider_trend_slope_30d: m.provider_trend_slope_30d,
    provider_cov_price_7d: m.provider_cov_price_7d,
    provider_cov_price_30d: m.provider_cov_price_30d,
    provider_price_relative_to_30d_range: m.provider_price_relative_to_30d_range,
    provider_min_price_all_time: m.provider_min_price_all_time,
    provider_min_price_all_time_date: m.provider_min_price_all_time_date,
    provider_max_price_all_time: m.provider_max_price_all_time,
    provider_max_price_all_time_date: m.provider_max_price_all_time_date,
    provider_as_of_ts: m.provider_as_of_ts,
    updated_at: now,
  }));

  const providerMetricsResult = await batchUpsert(
    supabase,
    "card_metrics",
    metricsRows,
    "canonical_slug,printing_id,grade",
  );
  itemsUpserted += providerMetricsResult.upserted;
  itemsFailed += providerMetricsResult.failed;
  firstError ??= providerMetricsResult.firstError;

  // ── Finalize ingest run ──────────────────────────────────────────────────────
  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: firstError === null,
        items_fetched: itemsFetched,
        items_upserted: itemsUpserted,
        items_failed: itemsFailed,
        ended_at: new Date().toISOString(),
        meta: {
          lastSetCode,
          nextSetCode,
          setsCount: setsToProcess.length,
          done,
          isDebug,
          firstError,
          historyPointsWritten: histResult.inserted,
          metricsSnapshotsWritten: providerMetricsResult.upserted,
        },
      })
      .eq("id", runId);
  }

  return NextResponse.json({
    ok: true,
    isDebug,
    setsProcessed: setsToProcess.length,
    done,
    itemsFetched,
    itemsUpserted,
    itemsFailed,
    historyPointsWritten: histResult.inserted,
    metricsSnapshotsWritten: providerMetricsResult.upserted,
    firstError,
    metricsRefreshResult,
    // Debug only: full JustTCG response envelopes for each set fetched.
    ...(isDebug && { debugRawResponses }),
  });
}
