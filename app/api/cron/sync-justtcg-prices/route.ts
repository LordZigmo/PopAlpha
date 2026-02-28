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
 *     canonical_cards        auto-created rows for sealed products
 *     price_snapshots        current NM/sealed price (upsert by provider_ref)
 *     price_history_points   priceHistory30d time series (ON CONFLICT DO NOTHING)
 *
 *   Layer 3 — analytics:
 *     card_metrics           refresh_card_metrics() then provider field upsert
 *
 * Asset types:
 *   'single'  — individual trading cards; matched via card_printings lookup
 *   'sealed'  — booster packs / boxes / ETBs; canonical row created on ingest
 *               canonical_slug = "sealed:{provider_card_id}"
 *               canonical_cards.variant = 'SEALED'
 *               printing_id = NULL in card_metrics and price_snapshots
 *
 * Sealed vs single separation in future ranking queries:
 *   sealed  → canonical_slug LIKE 'sealed:%'
 *   singles → canonical_slug NOT LIKE 'sealed:%'
 *
 * Debug params:
 *   ?set=base-set-pokemon     provider set ID (enables debug mode, skips cursor)
 *   ?asset=sealed|single|any  filter by asset type (default: any)
 *   ?sample=1                 scan cards until ONE qualifying item is found; process only that
 *   ?cardLimit=25             max cards to scan when sample=1 (default: all)
 *   ?force=1                  bypass idempotency check
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
  normalizeCondition,
  classifyJustTcgCard,
  buildSealedCanonicalSlug,
  mapVariantToMetrics,
  mapVariantToHistoryPoints,
  buildVariantRef,
  computeVariantSignals,
  type JustTcgCard,
} from "@/lib/providers/justtcg";
import type { MetricsSnapshot, PriceHistoryPoint } from "@/lib/providers/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOB = "justtcg_price_sync";
const PROVIDER = "JUSTTCG";
const SIGNAL_MIN_POINTS = 10; // minimum history points to compute signals

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
  edition: string;
  stamp: string | null;
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
    const url0 = new URL(req.url);
    const querySecret = url0.searchParams.get("secret")?.trim() ?? "";
    if (auth !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const debugSet    = url.searchParams.get("set")?.trim() ?? null;
  const assetFilter = (url.searchParams.get("asset")?.trim() ?? "any") as "sealed" | "single" | "any";
  const sampleMode  = url.searchParams.get("sample") === "1";
  const cardLimit   = parseInt(url.searchParams.get("cardLimit") ?? "0", 10) || null;
  const force       = url.searchParams.get("force") === "1";
  const isDebug     = !!debugSet;

  const supabase = getServerSupabaseClient();
  const now = new Date().toISOString();
  const runDate = now.slice(0, 10); // YYYY-MM-DD

  // ── Idempotency: skip if a complete run already finished today ───────────────
  // Debug mode also checks unless force=1.
  if (!force) {
    const { data: todayRun } = await supabase
      .from("ingest_runs")
      .select("id")
      .eq("job", JOB)
      .eq("status", "finished")
      .eq("ok", true)
      .gte("ended_at", `${runDate}T00:00:00Z`)
      .lte("ended_at", `${runDate}T23:59:59Z`)
      .contains("meta", { done: true })
      .limit(1)
      .maybeSingle();
    if (todayRun) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already completed today" });
    }
  }

  // ── Cursor from last non-debug run ──────────────────────────────────────────
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

  // In debug mode: process only the explicitly requested set ID.
  // setsToProcess[0] is used for the card_printings lookup (singles path).
  let setsToProcess: OurSet[];
  if (isDebug) {
    setsToProcess = allSets.length > 0 ? [allSets[0]] : [];
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
      meta: { lastSetCode, nextSetCode, setsCount: setsToProcess.length, done, isDebug, assetFilter, sampleMode },
    })
    .select("id")
    .single<{ id: string }>();
  const runId = runRow?.id ?? null;

  // ── Accumulators ────────────────────────────────────────────────────────────
  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;
  let firstError: string | null = null;

  // canonical_cards rows to upsert for sealed products.
  // MUST be written before price_history_points and price_snapshots (FK constraint).
  const sealedCanonicalUpserts: Record<string, unknown>[] = [];
  const allPriceSnapshots: Record<string, unknown>[] = [];
  const allHistoryPoints: PriceHistoryPoint[] = [];
  const allMetricsSnapshots: MetricsSnapshot[] = [];
  const allVariantMetrics: Record<string, unknown>[] = [];
  const allIngestRows: Record<string, unknown>[] = [];
  const mapUpserts: Record<string, unknown>[] = [];
  // Debug only: raw JustTCG envelopes + chosen sample item.
  const debugRawResponses: Array<{ providerSetId: string; httpStatus: number; envelope: unknown }> = [];
  let debugSampleItem: { name: string; assetType: string; canonicalSlug: string; variantRef: string } | null = null;

  // ── Process each set ────────────────────────────────────────────────────────
  for (const ourSet of setsToProcess) {
    const existing = setMapByCode.get(ourSet.setCode);
    const providerSetId = isDebug
      ? debugSet!
      : (existing?.provider_set_id ?? setNameToJustTcgId(ourSet.setName));

    try {
      // 1. Fetch cards from JustTCG.
      const { cards, rawEnvelope, httpStatus } = await fetchJustTcgCards(providerSetId, 1);

      if (isDebug) debugRawResponses.push({ providerSetId, httpStatus, envelope: rawEnvelope });

      // 2. Store raw payload (INSERT only; duplicate inserts are silently skipped).
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

      // 3. Surface non-200 responses as a named error and skip this set.
      if (httpStatus < 200 || httpStatus >= 300) {
        firstError ??= `JustTCG ${httpStatus} for set ${providerSetId}: ${JSON.stringify(rawEnvelope).slice(0, 200)}`;
        itemsFailed += 1;
        continue;
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

      // 5. Load our card_printings for this set (singles path only).
      const { data: printingsRaw } = await supabase
        .from("card_printings")
        .select("id, canonical_slug, card_number, finish, edition, stamp")
        .eq("set_code", ourSet.setCode)
        .eq("language", "EN")
        .not("canonical_slug", "is", null);

      const printings = (printingsRaw ?? []) as PrintingRow[];
      // Build lookup: normNum → finish → PrintingRow
      const byNumberAndFinish = new Map<string, Map<string, PrintingRow>>();
      const byNumber = new Map<string, PrintingRow>(); // fallback: any finish for this number
      for (const p of printings) {
        if (!p.card_number || !p.canonical_slug) continue;
        const normNum = normalizeCardNumber(p.card_number);
        let finishMap = byNumberAndFinish.get(normNum);
        if (!finishMap) { finishMap = new Map(); byNumberAndFinish.set(normNum, finishMap); }
        finishMap.set(p.finish, p);
        if (!byNumber.has(normNum) || p.finish === "NON_HOLO") byNumber.set(normNum, p);
      }

      // 6. Scan cards — build accumulators for singles and sealed.
      const cardsToScan: JustTcgCard[] = cardLimit ? cards.slice(0, cardLimit) : cards;
      let sampleFound = false;

      for (const card of cardsToScan) {
        // In sample mode, stop once one qualifying item has been fully processed.
        if (sampleMode && sampleFound) break;

        const assetType = classifyJustTcgCard(card);

        // Skip if this card doesn't match the requested asset filter.
        if (assetFilter !== "any" && assetType !== assetFilter) continue;

        itemsFetched += 1;

        if (assetType === "sealed") {
          // ── Sealed path ───────────────────────────────────────────────────
          // Find the first qualifying sealed variant.
          // In sample mode also require priceHistory to guarantee historyPointsWritten > 0.
          const sealedVariant = (card.variants ?? []).find((v) => {
            if (normalizeCondition(v.condition ?? "") !== "sealed") return false;
            if ((v.price ?? 0) <= 0) return false;
            if (sampleMode) {
              const hasHistory = (v.priceHistory?.length ?? 0) > 0 || (v.priceHistory30d?.length ?? 0) > 0;
              if (!hasHistory) return false;
            }
            return true;
          });
          if (!sealedVariant) continue;

          const canonicalSlug = buildSealedCanonicalSlug(card.id);
          const asOfTs = sealedVariant.lastUpdated
            ? new Date(sealedVariant.lastUpdated * 1000).toISOString()
            : now;
          // "sealed" overrides variant.printing; edition/stamp irrelevant for sealed.
          const variantRef = buildVariantRef("sealed", "unknown", null, sealedVariant.condition, sealedVariant.language ?? "English", "RAW");

          // Ensure canonical_cards row exists (upsert — safe to re-run).
          sealedCanonicalUpserts.push({
            slug: canonicalSlug,
            canonical_name: card.name,
            set_name: card.set_name ?? null,
            card_number: card.number,
            language: "EN",
            variant: "SEALED",
          });

          allIngestRows.push({
            provider: PROVIDER,
            job: JOB,
            set_id: providerSetId,
            card_id: card.id,
            variant_id: sealedVariant.id,
            canonical_slug: canonicalSlug,
            printing_id: null,
            raw_payload: {
              variantId: sealedVariant.id,
              variantRef,
              cardId: card.id,
              setId: providerSetId,
              cardNumber: card.number,
              condition: sealedVariant.condition,
              printing: sealedVariant.printing,
              price: sealedVariant.price,
              trendSlope7d: sealedVariant.trendSlope7d ?? null,
              covPrice30d: sealedVariant.covPrice30d ?? null,
              priceRelativeTo30dRange: sealedVariant.priceRelativeTo30dRange ?? null,
              minPriceAllTime: sealedVariant.minPriceAllTime ?? null,
              maxPriceAllTime: sealedVariant.maxPriceAllTime ?? null,
              lastUpdated: sealedVariant.lastUpdated ?? null,
            },
          });

          allPriceSnapshots.push({
            canonical_slug: canonicalSlug,
            printing_id: null,
            grade: "RAW",
            price_value: sealedVariant.price,
            currency: "USD",
            provider: PROVIDER,
            provider_ref: `justtcg-${sealedVariant.id}`,
            ingest_id: null,
            observed_at: asOfTs,
          });

          allHistoryPoints.push(
            ...mapVariantToHistoryPoints(sealedVariant, canonicalSlug, "sealed", "unknown", null, "RAW"),
          );

          const sealedMetrics = mapVariantToMetrics(sealedVariant, canonicalSlug, null, "RAW", asOfTs);
          if (sealedMetrics) {
            allMetricsSnapshots.push(sealedMetrics);
            const historyPointCount = (sealedVariant.priceHistory?.length ?? sealedVariant.priceHistory30d?.length ?? 0);
            const hasSufficientData = historyPointCount >= SIGNAL_MIN_POINTS;
            const sigs = hasSufficientData
              ? computeVariantSignals(sealedMetrics.provider_trend_slope_7d, sealedMetrics.provider_cov_price_30d, sealedMetrics.provider_price_relative_to_30d_range, sealedMetrics.provider_price_changes_count_30d)
              : { signal_trend: null, signal_breakout: null, signal_value: null };
            allVariantMetrics.push({
              canonical_slug: canonicalSlug,
              variant_ref: variantRef,
              provider: PROVIDER,
              grade: "RAW",
              provider_trend_slope_7d: sealedMetrics.provider_trend_slope_7d,
              provider_cov_price_30d: sealedMetrics.provider_cov_price_30d,
              provider_price_relative_to_30d_range: sealedMetrics.provider_price_relative_to_30d_range,
              provider_price_changes_count_30d: sealedMetrics.provider_price_changes_count_30d,
              provider_as_of_ts: asOfTs,
              history_points_30d: historyPointCount,
              signal_trend: sigs.signal_trend,
              signal_breakout: sigs.signal_breakout,
              signal_value: sigs.signal_value,
              signals_as_of_ts: hasSufficientData ? now : null,
              updated_at: now,
            });
          }

          if (sampleMode) {
            sampleFound = true;
            debugSampleItem = { name: card.name, assetType: "sealed", canonicalSlug, variantRef };
          }

        } else {
          // ── Singles path ──────────────────────────────────────────────────
          const normNum = normalizeCardNumber(card.number);

          for (const variant of card.variants ?? []) {
            // Singles: only ingest Near Mint condition.
            if (normalizeCondition(variant.condition ?? "") !== "nm") continue;
            if (!variant.price || variant.price <= 0) continue;
            // In sample mode, skip variants without history to guarantee historyPointsWritten > 0.
            if (sampleMode) {
              const hasHistory = (variant.priceHistory?.length ?? 0) > 0 || (variant.priceHistory30d?.length ?? 0) > 0;
              if (!hasHistory) continue;
            }

            const mappedFinish = mapJustTcgPrinting(variant.printing ?? "");
            const finishMap = byNumberAndFinish.get(normNum);
            const printing = finishMap?.get(mappedFinish) ?? byNumber.get(normNum) ?? null;

            const asOfTs = variant.lastUpdated
              ? new Date(variant.lastUpdated * 1000).toISOString()
              : now;
            // variant_ref includes edition + stamp from matched card_printing for full cohort identity.
            const variantRef = buildVariantRef(
              variant.printing ?? "normal",
              printing?.edition ?? "UNKNOWN",
              printing?.stamp ?? null,
              variant.condition,
              variant.language ?? "English",
              "RAW",
            );

            // Audit row (written even when no printing match — useful for gap analysis).
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
                variantRef,
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

            // Downstream writes require a printing match.
            if (!printing) continue;

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

            allHistoryPoints.push(
              ...mapVariantToHistoryPoints(variant, printing.canonical_slug, variant.printing ?? "normal", printing.edition, printing.stamp, "RAW"),
            );

            const metrics = mapVariantToMetrics(variant, printing.canonical_slug, printing.id, "RAW", asOfTs);
            if (metrics) {
              allMetricsSnapshots.push(metrics);
              const historyPointCount = (variant.priceHistory?.length ?? variant.priceHistory30d?.length ?? 0);
              const hasSufficientData = historyPointCount >= SIGNAL_MIN_POINTS;
              const sigs = hasSufficientData
                ? computeVariantSignals(metrics.provider_trend_slope_7d, metrics.provider_cov_price_30d, metrics.provider_price_relative_to_30d_range, metrics.provider_price_changes_count_30d)
                : { signal_trend: null, signal_breakout: null, signal_value: null };
              allVariantMetrics.push({
                canonical_slug: printing.canonical_slug,
                variant_ref: variantRef,
                provider: PROVIDER,
                grade: "RAW",
                provider_trend_slope_7d: metrics.provider_trend_slope_7d,
                provider_cov_price_30d: metrics.provider_cov_price_30d,
                provider_price_relative_to_30d_range: metrics.provider_price_relative_to_30d_range,
                provider_price_changes_count_30d: metrics.provider_price_changes_count_30d,
                provider_as_of_ts: asOfTs,
                history_points_30d: historyPointCount,
                signal_trend: sigs.signal_trend,
                signal_breakout: sigs.signal_breakout,
                signal_value: sigs.signal_value,
                signals_as_of_ts: hasSufficientData ? now : null,
                updated_at: now,
              });
            }

            if (sampleMode) {
              sampleFound = true;
              debugSampleItem = { name: card.name, assetType: "single", canonicalSlug: printing.canonical_slug, variantRef };
              break; // one variant per card in sample mode
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= `set ${ourSet.setCode}: ${msg}`;
      itemsFailed += 1;
    }
  }

  // ── Batch writes ─────────────────────────────────────────────────────────────

  // Sealed canonical_cards FIRST — price_history_points + price_snapshots have FK on canonical_cards.slug.
  if (sealedCanonicalUpserts.length > 0) {
    const sealedResult = await batchUpsert(supabase, "canonical_cards", sealedCanonicalUpserts, "slug");
    firstError ??= sealedResult.firstError;
    if (sealedResult.failed > 0) itemsFailed += sealedResult.failed;
  }

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

  // refresh_card_metrics() — compute median/volatility stats from price_snapshots
  let metricsRefreshResult: unknown = null;
  try {
    const { data } = await supabase.rpc("refresh_card_metrics");
    metricsRefreshResult = data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    firstError ??= `refresh_card_metrics: ${msg}`;
  }

  // Upsert provider-supplied analytics fields to card_metrics (after refresh).
  // Only writes provider_* columns — does NOT overwrite computed stats (median_7d etc.).
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
    provider_price_changes_count_30d: m.provider_price_changes_count_30d,
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

  // variant_metrics — per-cohort signals keyed by (canonical_slug, variant_ref, provider, grade)
  const variantMetricsResult = await batchUpsert(
    supabase,
    "variant_metrics",
    allVariantMetrics,
    "canonical_slug,variant_ref,provider,grade",
  );
  itemsUpserted += variantMetricsResult.upserted;
  itemsFailed += variantMetricsResult.failed;
  firstError ??= variantMetricsResult.firstError;

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
          assetFilter,
          sampleMode,
          firstError,
          historyPointsWritten: histResult.inserted,
          metricsSnapshotsWritten: providerMetricsResult.upserted,
          variantMetricsWritten: variantMetricsResult.upserted,
        },
      })
      .eq("id", runId);
  }

  return NextResponse.json({
    ok: true,
    isDebug,
    assetFilter,
    sampleMode,
    setsProcessed: setsToProcess.length,
    done,
    itemsFetched,
    itemsUpserted,
    itemsFailed,
    historyPointsWritten: histResult.inserted,
    metricsSnapshotsWritten: providerMetricsResult.upserted,
    variantMetricsWritten: variantMetricsResult.upserted,
    firstError,
    metricsRefreshResult,
    ...(isDebug && { debugSampleItem, debugRawResponses }),
  });
}
