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
 *     card_metrics           refresh_card_metrics() for legacy market snapshots
 *     variant_metrics        provider analytics + derived signals per variant_ref
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
 *   ?limit=1                  max cards processed in debug mode (after provider fetch)
 *   ?force=1                  bypass idempotency check
 *
 * Rate limits (Enterprise): 500K/month · 50K/day · 500/min
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { buildTrackedSelectionPlan } from "@/lib/cron/justtcg-tracked-selection.mjs";
import { buildRawVariantRef } from "@/lib/identity/variant-ref";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  fetchJustTcgCards,
  setNameToJustTcgId,
  bestSetMatch,
  normalizeSetNameForMatch,
  mapJustTcgPrinting,
  normalizeCardNumber,
  normalizeCondition,
  classifyJustTcgCard,
  buildSealedCanonicalSlug,
  mapVariantToMetrics,
  mapVariantToHistoryPoints,
  buildLegacyVariantRef,
  type JustTcgCard,
} from "@/lib/providers/justtcg";
import type { PriceHistoryPoint } from "@/lib/providers/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOB = "justtcg_price_sync";
const NIGHTLY_JOB = "sync_justtcg_prices_nightly";
const PROVIDER = "JUSTTCG";
const SETS_PER_RUN = process.env.JUSTTCG_SETS_PER_RUN
  ? parseInt(process.env.JUSTTCG_SETS_PER_RUN, 10)
  : 100;
const NIGHTLY_DEFAULT_LIMIT = 100;
const NIGHTLY_MAX_REQUESTS_PER_RUN = 100;
const NIGHTLY_JITTER_MS = 80;
const NIGHTLY_INCREMENTAL_SIGNAL_LIMIT = 500;

// ── Types ──────────────────────────────────────────────────────────────────────

type OurSet = { setCode: string; setName: string };

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string | null;
  finish: string;
  edition: string;
  stamp: string | null;
  set_code?: string | null;
  set_name?: string | null;
};

type MarketLatestRow = {
  card_id: string;
  source: string;
  grade: string;
  price_type: string;
  price_usd: number;
  currency: string;
  volume: number | null;
  external_id: string;
  url: string | null;
  observed_at: string;
  canonical_slug: string;
  printing_id: string;
  updated_at: string;
};

type NightlyMappingRow = {
  id: string;
  card_id: string;
  source: string;
  mapping_type: string;
  external_id: string;
  meta: Record<string, unknown> | null;
  canonical_slug: string | null;
  printing_id: string | null;
  created_at: string;
};

type TrackedAssetRow = {
  canonical_slug: string;
  printing_id: string;
  grade: string;
  priority: number;
  enabled: boolean;
  created_at: string;
};

type TrackedSkipReason =
  | "MISSING_JUSTTCG_MAPPING"
  | "MISSING_PROVIDER_SET_ID"
  | "MISSING_PROVIDER_VARIANT_ID"
  | "MISSING_PRINTING_ID"
  | "NO_JUSTTCG_SET_FETCH_RESULT"
  | "VARIANT_NOT_MAPPED_IN_SET";

type TrackedSkipSample = {
  canonical_slug: string;
  printing_id: string;
  reason: TrackedSkipReason;
  mapping_id?: string;
  provider_set_id?: string;
  provider_variant_id?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function requestHash(provider: string, endpoint: string, params: Record<string, unknown>): string {
  const str = JSON.stringify({ provider, endpoint, params });
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function toProviderObservedAt(raw: number | null | undefined, fallbackIso: string): string {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallbackIso;
  const millis = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  return new Date(millis).toISOString();
}

function buildTrimmedVariantAuditPayload(variant: {
  id: string;
  price: number;
  trendSlope7d?: number;
  covPrice30d?: number;
  priceRelativeTo30dRange?: number;
  priceChangesCount30d?: number;
  priceHistory?: Array<unknown>;
  priceHistory30d?: Array<unknown>;
}) {
  return {
    variantId: variant.id,
    price: variant.price,
    trendSlope7d: variant.trendSlope7d ?? null,
    covPrice30d: variant.covPrice30d ?? null,
    priceRelativeTo30dRange: variant.priceRelativeTo30dRange ?? null,
    priceChangesCount30d: variant.priceChangesCount30d ?? null,
    priceHistory: {
      window: "30d",
      count: variant.priceHistory?.length ?? variant.priceHistory30d?.length ?? 0,
      usedField: (variant.priceHistory?.length ?? 0) > 0 ? "priceHistory" : "priceHistory30d",
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNightlyCursor(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pushTrackedSkip(params: {
  trackedOnly: boolean;
  canonicalSlug: string;
  printingId: string;
  reason: TrackedSkipReason;
  skipReasonCounts: Partial<Record<TrackedSkipReason, number>>;
  skippedSamples: TrackedSkipSample[];
  diagnosticsRows: Array<Record<string, unknown>>;
  runId: string | null;
  mappingId?: string | null;
  providerSetId?: string | null;
  providerVariantId?: string | null;
}) {
  const {
    trackedOnly,
    canonicalSlug,
    printingId,
    reason,
    skipReasonCounts,
    skippedSamples,
    diagnosticsRows,
    runId,
    mappingId,
    providerSetId,
    providerVariantId,
  } = params;
  if (!trackedOnly) return;

  skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1;
  if (skippedSamples.length < 25) {
    skippedSamples.push({
      canonical_slug: canonicalSlug,
      printing_id: printingId,
      reason,
      ...(mappingId ? { mapping_id: mappingId } : {}),
      ...(providerSetId ? { provider_set_id: providerSetId } : {}),
      ...(providerVariantId ? { provider_variant_id: providerVariantId } : {}),
    });
  }
  diagnosticsRows.push({
    run_id: runId,
    canonical_slug: canonicalSlug,
    printing_id: printingId,
    reason,
    meta: {
      ...(mappingId ? { mapping_id: mappingId } : {}),
      ...(providerSetId ? { provider_set_id: providerSetId } : {}),
      ...(providerVariantId ? { provider_variant_id: providerVariantId } : {}),
    },
  });
}

function setNamesAreCompatible(providerSetName: string, candidateSetName: string): boolean {
  const providerNorm = normalizeSetNameForMatch(providerSetName);
  const candidateNorm = normalizeSetNameForMatch(candidateSetName);
  if (!providerNorm || !candidateNorm) return false;
  if (providerNorm === candidateNorm) return true;

  const providerTokens = providerNorm.split(" ").filter(Boolean);
  const candidateTokens = candidateNorm.split(" ").filter(Boolean);
  const providerNoSet = providerTokens.filter((token) => token !== "set");
  const candidateNoSet = candidateTokens.filter((token) => token !== "set");

  return providerNoSet.join(" ") === candidateNoSet.join(" ");
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
  selectColumn?: string,
  batchSize = 500,
): Promise<{ inserted: number; firstError: string | null }> {
  let inserted = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    if (selectColumn) {
      const { data, error } = await supabase
        .from(table)
        .upsert(batch, { onConflict, ignoreDuplicates: true })
        .select(selectColumn);
      if (error) {
        firstError ??= `${table}: ${error.message}`;
      } else {
        inserted += (data as Array<unknown> | null)?.length ?? 0;
      }
      continue;
    }
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

function queuePrintingBackedVariantWrite(params: {
  jobName: string;
  providerSetId: string;
  card: JustTcgCard;
  variant: JustTcgCard["variants"][number];
  printing: PrintingRow;
  now: string;
  allIngestRows: Record<string, unknown>[];
  allPriceSnapshots: Record<string, unknown>[];
  allMarketLatestRows: MarketLatestRow[];
  allHistoryPoints: PriceHistoryPoint[];
  allVariantMetrics: Record<string, unknown>[];
  variantAuditRows: Record<string, unknown>[];
  cardExternalMappingsUpserts: Record<string, unknown>[];
}) {
  const {
    jobName,
    providerSetId,
    card,
    variant,
    printing,
    now,
    allIngestRows,
    allPriceSnapshots,
    allMarketLatestRows,
    allHistoryPoints,
    allVariantMetrics,
    variantAuditRows,
    cardExternalMappingsUpserts,
  } = params;
  const variantRef = buildRawVariantRef(printing.id);
  const asOfTs = toProviderObservedAt(variant.lastUpdated ?? null, now);

  allIngestRows.push({
    provider: PROVIDER,
    job: jobName,
    set_id: providerSetId,
    card_id: card.id,
    variant_id: variant.id,
    canonical_slug: printing.canonical_slug,
    printing_id: printing.id,
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

  variantAuditRows.push({
    provider: PROVIDER,
    endpoint: "/cards/variant",
    params: {
      set: providerSetId,
      cardId: card.id,
      variantId: variant.id,
      window: "30d",
    },
    response: buildTrimmedVariantAuditPayload(variant),
    status_code: 200,
    fetched_at: now,
    request_hash: requestHash(PROVIDER, "/cards/variant", {
      set: providerSetId,
      cardId: card.id,
      variantId: variant.id,
      variantRef,
    }),
    canonical_slug: printing.canonical_slug,
    variant_ref: variantRef,
  });

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

  allMarketLatestRows.push({
    card_id: variant.id,
    source: PROVIDER,
    grade: "RAW",
    price_type: "MARKET",
    price_usd: variant.price,
    currency: "USD",
    volume: null,
    external_id: variant.id,
    url: null,
    observed_at: asOfTs,
    canonical_slug: printing.canonical_slug,
    printing_id: printing.id,
    updated_at: now,
  });

  allHistoryPoints.push(
    ...mapVariantToHistoryPoints(variant, printing.canonical_slug, variantRef),
  );

  const metrics = mapVariantToMetrics(variant, printing.canonical_slug, printing.id, "RAW", asOfTs);
  if (metrics) {
    const historyPointCount = (variant.priceHistory?.length ?? variant.priceHistory30d?.length ?? 0);
    allVariantMetrics.push({
      canonical_slug: printing.canonical_slug,
      printing_id: printing.id,
      variant_ref: variantRef,
      provider: PROVIDER,
      grade: "RAW",
      provider_trend_slope_7d: metrics.provider_trend_slope_7d,
      provider_cov_price_30d: metrics.provider_cov_price_30d,
      provider_price_relative_to_30d_range: metrics.provider_price_relative_to_30d_range,
      provider_price_changes_count_30d: metrics.provider_price_changes_count_30d,
      provider_as_of_ts: asOfTs,
      history_points_30d: historyPointCount,
      signal_trend: null,
      signal_breakout: null,
      signal_value: null,
      signals_as_of_ts: null,
      updated_at: now,
    });
  }

  cardExternalMappingsUpserts.push({
    card_id: printing.id,
    source: PROVIDER,
    mapping_type: "printing",
    external_id: variant.id,
    meta: {
      provider_set_id: providerSetId,
      provider_card_id: card.id,
      provider_variant_id: variant.id,
      provider_card_number: card.number,
      provider_printing: variant.printing ?? null,
      provider_condition: variant.condition ?? null,
      provider_page: 1,
    },
    canonical_slug: printing.canonical_slug,
    printing_id: printing.id,
  });
}

async function runNightlySync(params: {
  req: Request;
  supabase: ReturnType<typeof getServerSupabaseClient>;
  now: string;
  authDeprecatedQueryAuth: boolean;
  limit: number;
  cursor: number;
  trackedOnly: boolean;
}) {
  const { req, supabase, now, authDeprecatedQueryAuth, limit, cursor, trackedOnly } = params;
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const { data: runRow } = await supabase
    .from("ingest_runs")
    .insert({
      job: NIGHTLY_JOB,
      source: "justtcg",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        mode: "nightly",
        limit,
        cursor,
        trackedOnly,
        requestCap: NIGHTLY_MAX_REQUESTS_PER_RUN,
        force,
      },
    })
    .select("id")
    .single<{ id: string }>();
  const runId = runRow?.id ?? null;

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;
  let firstError: string | null = null;
  let requestCount = 0;
  let signalsRowsUpdatedIncremental = 0;
  let signalsRowsUpdatedFull = 0;
  let signalsRefreshMode: "incremental" | "full" | "none" = "none";
  const skipReasonCounts: Partial<Record<TrackedSkipReason, number>> = {};
  const skippedSamples: TrackedSkipSample[] = [];
  const diagnosticsRows: Array<Record<string, unknown>> = [];

  let mappings: NightlyMappingRow[] = [];
  let nextCursor: string | null = null;

  if (trackedOnly) {
    const { data: trackedRows, error: trackedError } = await supabase
      .from("tracked_assets")
      .select("canonical_slug, printing_id, grade, priority, enabled, created_at")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 4, limit));

    if (trackedError) {
      if (runId) {
        await supabase
          .from("ingest_runs")
          .update({
            status: "finished",
            ok: false,
            items_fetched: 0,
            items_upserted: 0,
            items_failed: 1,
            ended_at: new Date().toISOString(),
            meta: { mode: "nightly", trackedOnly, limit, cursor, firstError: trackedError.message },
          })
          .eq("id", runId);
      }
      return NextResponse.json({ ok: false, error: trackedError.message }, { status: 500 });
    }

    const tracked = ((trackedRows ?? []) as TrackedAssetRow[])
      .filter((row) => row.enabled && row.grade === "RAW")
      .slice(cursor, cursor + limit);
    nextCursor = tracked.length === limit ? String(cursor + tracked.length) : null;

    const trackedPrintingIds = Array.from(new Set(tracked.map((row) => row.printing_id).filter(Boolean)));
    if (trackedPrintingIds.length > 0) {
      const { data: trackedMappingRows, error: trackedMappingError } = await supabase
        .from("card_external_mappings")
        .select("id, card_id, source, mapping_type, external_id, meta, canonical_slug, printing_id, created_at")
      .eq("source", PROVIDER)
      .eq("mapping_type", "printing")
      .in("printing_id", trackedPrintingIds)
      .order("created_at", { ascending: false });

      if (trackedMappingError) {
        if (runId) {
          await supabase
            .from("ingest_runs")
            .update({
              status: "finished",
              ok: false,
              items_fetched: 0,
              items_upserted: 0,
              items_failed: 1,
              ended_at: new Date().toISOString(),
              meta: { mode: "nightly", trackedOnly, limit, cursor, firstError: trackedMappingError.message },
            })
            .eq("id", runId);
        }
        return NextResponse.json({ ok: false, error: trackedMappingError.message }, { status: 500 });
      }

      const selectionPlan = buildTrackedSelectionPlan(
        tracked.map((row) => ({
          canonical_slug: row.canonical_slug,
          printing_id: row.printing_id,
        })),
        (trackedMappingRows ?? []) as NightlyMappingRow[],
      );

      for (const entry of selectionPlan.skippedEntries) {
        skipped += 1;
          pushTrackedSkip({
            trackedOnly,
            canonicalSlug: entry.canonical_slug,
            printingId: entry.printing_id,
            reason: entry.reason as TrackedSkipReason,
            skipReasonCounts,
            skippedSamples,
            diagnosticsRows,
          runId,
          mappingId: entry.mapping_id,
          providerSetId: entry.provider_set_id,
        });
      }

      mappings.push(...(selectionPlan.eligibleMappings as NightlyMappingRow[]));
    }
  } else {
    const { data: mappingRows, error: mappingError } = await supabase
      .from("card_external_mappings")
      .select("id, card_id, source, mapping_type, external_id, meta, canonical_slug, printing_id, created_at")
      .eq("source", PROVIDER)
      .not("printing_id", "is", null)
      .order("created_at", { ascending: false })
      .range(cursor, cursor + limit - 1);

    if (mappingError) {
      if (runId) {
        await supabase
          .from("ingest_runs")
          .update({
            status: "finished",
            ok: false,
            items_fetched: 0,
            items_upserted: 0,
            items_failed: 1,
            ended_at: new Date().toISOString(),
            meta: { mode: "nightly", trackedOnly, limit, cursor, firstError: mappingError.message },
          })
          .eq("id", runId);
      }
      return NextResponse.json({ ok: false, error: mappingError.message }, { status: 500 });
    }

    mappings = ((mappingRows ?? []) as NightlyMappingRow[]).filter((row) => !!row.printing_id);
    nextCursor = mappings.length === limit ? String(cursor + mappings.length) : null;
  }

  if (mappings.length === 0) {
    if (diagnosticsRows.length > 0) {
      await supabase.from("tracked_refresh_diagnostics").insert(diagnosticsRows);
    }
    if (runId) {
      await supabase
        .from("ingest_runs")
        .update({
          status: "finished",
          ok: true,
          items_fetched: 0,
          items_upserted: 0,
          items_failed: 0,
          ended_at: new Date().toISOString(),
          meta: {
            mode: "nightly",
            trackedOnly,
            limit,
            cursor,
            nextCursor,
            processed: 0,
            skipped,
            failed: 0,
            skipReasonCounts,
            skippedSamples,
            updatedVariantKeyCount: 0,
            updatedVariantKeys: [],
            updatedVariantKeysHash: null,
            signalsRowsUpdatedIncremental: 0,
            signalsRowsUpdatedFull: 0,
            signalsRefreshMode: "none",
            done: true,
          },
        })
        .eq("id", runId);
    }
    return NextResponse.json({
      ok: true,
      mode: "nightly",
      trackedOnly,
      processed: 0,
      skipped,
      failed: 0,
      skipReasonCounts,
      skippedSamples,
      updatedVariantKeyCount: 0,
      nextCursor,
      outboundRequests: 0,
      requestCap: NIGHTLY_MAX_REQUESTS_PER_RUN,
      signalsRowsUpdatedIncremental: 0,
      signalsRowsUpdatedFull: 0,
      signalsRefreshMode: "none",
      deprecatedQueryAuth: authDeprecatedQueryAuth,
    });
  }

  const printingIds = Array.from(new Set(mappings.map((row) => row.printing_id!).filter(Boolean)));
  const { data: printingsRaw, error: printingsError } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, card_number, finish, edition, stamp, set_code, set_name")
    .in("id", printingIds);

  if (printingsError) {
    if (runId) {
      await supabase
        .from("ingest_runs")
        .update({
          status: "finished",
          ok: false,
          items_fetched: 0,
          items_upserted: 0,
          items_failed: 1,
          ended_at: new Date().toISOString(),
          meta: { mode: "nightly", trackedOnly, limit, cursor, firstError: printingsError.message },
        })
        .eq("id", runId);
    }
    return NextResponse.json({ ok: false, error: printingsError.message }, { status: 500 });
  }

  const printingById = new Map<string, PrintingRow>();
  for (const row of (printingsRaw ?? []) as PrintingRow[]) {
    printingById.set(row.id, row);
  }

  const allPriceSnapshots: Record<string, unknown>[] = [];
  const allMarketLatestRows: MarketLatestRow[] = [];
  const allHistoryPoints: PriceHistoryPoint[] = [];
  const allVariantMetrics: Record<string, unknown>[] = [];
  const allIngestRows: Record<string, unknown>[] = [];
  const variantAuditRows: Record<string, unknown>[] = [];
  const cardExternalMappingsUpserts: Record<string, unknown>[] = [];

  const mappingsBySet = new Map<string, NightlyMappingRow[]>();
  for (const row of mappings) {
    const providerSetId = typeof row.meta?.provider_set_id === "string" ? row.meta.provider_set_id : null;
    if (!providerSetId) {
      skipped += 1;
      pushTrackedSkip({
        trackedOnly,
        canonicalSlug: row.canonical_slug ?? "",
        printingId: row.printing_id ?? "",
        reason: "MISSING_PROVIDER_SET_ID",
        skipReasonCounts,
        skippedSamples,
        diagnosticsRows,
        runId,
        mappingId: row.id,
      });
      continue;
    }
    const bucket = mappingsBySet.get(providerSetId) ?? [];
    bucket.push(row);
    mappingsBySet.set(providerSetId, bucket);
  }

  for (const [providerSetId, rows] of mappingsBySet) {
    if (requestCount >= NIGHTLY_MAX_REQUESTS_PER_RUN) {
      skipped += rows.length;
      firstError ??= `nightly request cap reached (${NIGHTLY_MAX_REQUESTS_PER_RUN})`;
      break;
    }

    if (requestCount > 0) {
      await sleep(NIGHTLY_JITTER_MS + Math.floor(Math.random() * 40));
    }

    requestCount += 1;
    const { cards, httpStatus, rawEnvelope } = await fetchJustTcgCards(providerSetId, 1);

    if (httpStatus < 200 || httpStatus >= 300) {
      firstError ??= `JustTCG ${httpStatus} for set ${providerSetId}: ${JSON.stringify(rawEnvelope).slice(0, 200)}`;
      failed += rows.length;
      itemsFailed += rows.length;
      continue;
    }

    for (const mapping of rows) {
      const printingId = mapping.printing_id;
      if (!printingId) {
        skipped += 1;
        pushTrackedSkip({
          trackedOnly,
          canonicalSlug: mapping.canonical_slug ?? "",
          printingId: "",
          reason: "MISSING_PRINTING_ID",
          skipReasonCounts,
          skippedSamples,
          diagnosticsRows,
          runId,
          mappingId: mapping.id,
          providerSetId,
        });
        continue;
      }
      const printing = printingById.get(printingId);
      if (!printing) {
        skipped += 1;
        pushTrackedSkip({
          trackedOnly,
          canonicalSlug: mapping.canonical_slug ?? "",
          printingId,
          reason: "MISSING_PRINTING_ID",
          skipReasonCounts,
          skippedSamples,
          diagnosticsRows,
          runId,
          mappingId: mapping.id,
          providerSetId,
        });
        continue;
      }

      const providerVariantId =
        typeof mapping.meta?.provider_variant_id === "string"
          ? mapping.meta.provider_variant_id
          : (typeof mapping.external_id === "string" && mapping.external_id.trim() ? mapping.external_id : null);
      const providerCardId = typeof mapping.meta?.provider_card_id === "string" ? mapping.meta.provider_card_id : null;
      const providerPrinting = typeof mapping.meta?.provider_printing === "string" ? mapping.meta.provider_printing : null;

      let selectedCard: JustTcgCard | null =
        providerCardId ? cards.find((card) => card.id === providerCardId) ?? null : null;
      let selectedVariant: JustTcgCard["variants"][number] | null = null;

      if (providerVariantId) {
        if (!selectedCard) {
          selectedCard = cards.find((card) => (card.variants ?? []).some((variant) => variant.id === providerVariantId)) ?? null;
        }
        selectedVariant = selectedCard?.variants.find((variant) => variant.id === providerVariantId) ?? null;
      }

      if (!selectedCard) {
        skipped += 1;
        pushTrackedSkip({
          trackedOnly,
          canonicalSlug: printing.canonical_slug,
          printingId,
          reason: "NO_JUSTTCG_SET_FETCH_RESULT",
          skipReasonCounts,
          skippedSamples,
          diagnosticsRows,
          runId,
          mappingId: mapping.id,
          providerSetId,
          providerVariantId: providerVariantId ?? undefined,
        });
        continue;
      }
      if (!selectedVariant && selectedCard) {
        const expectedFinish = mapJustTcgPrinting(providerPrinting ?? "");
        selectedVariant =
          selectedCard.variants.find((variant) => variant.id === mapping.external_id) ??
          selectedCard.variants.find((variant) =>
            normalizeCondition(variant.condition ?? "") === "nm"
            && mapJustTcgPrinting(variant.printing ?? "") === expectedFinish,
          ) ??
          selectedCard.variants.find((variant) => normalizeCondition(variant.condition ?? "") === "nm") ??
          null;
      }

      if (!selectedCard || !selectedVariant || !selectedVariant.price || selectedVariant.price <= 0) {
        skipped += 1;
        pushTrackedSkip({
          trackedOnly,
          canonicalSlug: printing.canonical_slug,
          printingId,
          reason: "VARIANT_NOT_MAPPED_IN_SET",
          skipReasonCounts,
          skippedSamples,
          diagnosticsRows,
          runId,
          mappingId: mapping.id,
          providerSetId,
          providerVariantId: providerVariantId ?? undefined,
        });
        continue;
      }

      itemsFetched += 1;
      processed += 1;
      queuePrintingBackedVariantWrite({
        jobName: NIGHTLY_JOB,
        providerSetId,
        card: selectedCard,
        variant: selectedVariant,
        printing,
        now,
        allIngestRows,
        allPriceSnapshots,
        allMarketLatestRows,
        allHistoryPoints,
        allVariantMetrics,
        variantAuditRows,
        cardExternalMappingsUpserts,
      });
    }
  }

  if (cardExternalMappingsUpserts.length > 0) {
    for (let i = 0; i < cardExternalMappingsUpserts.length; i += 250) {
      const { error } = await supabase
      .from("card_external_mappings")
      .upsert(cardExternalMappingsUpserts.slice(i, i + 250), { onConflict: "card_id,source,mapping_type" });
      if (error) {
        firstError ??= `card_external_mappings: ${error.message}`;
        itemsFailed += Math.min(250, cardExternalMappingsUpserts.length - i);
        failed += Math.min(250, cardExternalMappingsUpserts.length - i);
        break;
      }
    }
  }

  if (allIngestRows.length > 0) {
    for (let i = 0; i < allIngestRows.length; i += 250) {
      const { error } = await supabase.from("provider_ingests").insert(allIngestRows.slice(i, i + 250));
      if (error) {
        firstError ??= `provider_ingests: ${error.message}`;
        itemsFailed += Math.min(250, allIngestRows.length - i);
        break;
      }
    }
  }

  if (variantAuditRows.length > 0) {
    for (let i = 0; i < variantAuditRows.length; i += 250) {
      const { error } = await supabase.from("provider_raw_payloads").insert(variantAuditRows.slice(i, i + 250));
      if (error) {
        firstError ??= `provider_raw_payloads: ${error.message}`;
        break;
      }
    }
  }

  const snapResult = await batchUpsert(
    supabase,
    "price_snapshots",
    allPriceSnapshots as Record<string, unknown>[],
    "provider,provider_ref",
  );
  itemsUpserted += snapResult.upserted;
  itemsFailed += snapResult.failed;
  failed += snapResult.failed;
  firstError ??= snapResult.firstError;

  let marketLatestWritten = 0;
  if (allMarketLatestRows.length > 0) {
    const marketLatestResult = await batchUpsert(
      supabase,
      "market_latest",
      allMarketLatestRows as unknown as Record<string, unknown>[],
      "card_id,source,grade,price_type",
    );
    itemsUpserted += marketLatestResult.upserted;
    itemsFailed += marketLatestResult.failed;
    failed += marketLatestResult.failed;
    firstError ??= marketLatestResult.firstError;
    marketLatestWritten = marketLatestResult.upserted;
  }

  let historyPointsWritten = 0;
  if (allHistoryPoints.length > 0) {
    const historyInsert = await batchInsertIgnore(
      supabase,
      "price_history_points",
      allHistoryPoints as unknown as Record<string, unknown>[],
      "canonical_slug,variant_ref,provider,ts",
      "ts",
    );
    historyPointsWritten = historyInsert.inserted;
    firstError ??= historyInsert.firstError;
  }

  const historyCountByVariantRef = new Map<string, number>();
  for (const point of allHistoryPoints) {
    if (point.provider !== PROVIDER || point.source_window !== "30d") continue;
    historyCountByVariantRef.set(point.variant_ref, (historyCountByVariantRef.get(point.variant_ref) ?? 0) + 1);
  }
  for (const row of allVariantMetrics) {
    const variantRef = String(row.variant_ref ?? "");
    if (!variantRef) continue;
    row.history_points_30d = historyCountByVariantRef.get(variantRef) ?? Number(row.history_points_30d ?? 0);
  }

  let variantMetricsWritten = 0;
  if (allVariantMetrics.length > 0) {
    const variantMetricsResult = await batchUpsert(
      supabase,
      "variant_metrics",
      allVariantMetrics,
      "canonical_slug,variant_ref,provider,grade",
    );
    itemsUpserted += variantMetricsResult.upserted;
    itemsFailed += variantMetricsResult.failed;
    failed += variantMetricsResult.failed;
    firstError ??= variantMetricsResult.firstError;
    variantMetricsWritten = variantMetricsResult.upserted;
  }

  const updatedVariantKeysRaw = allVariantMetrics.map((row) => ({
    canonical_slug: String(row.canonical_slug ?? ""),
    variant_ref: String(row.variant_ref ?? ""),
    provider: String(row.provider ?? ""),
    grade: String(row.grade ?? ""),
  }));
  const updatedVariantKeysMap = new Map<string, { canonical_slug: string; variant_ref: string; provider: string; grade: string }>();
  for (const key of updatedVariantKeysRaw) {
    if (!key.canonical_slug || !key.variant_ref || !key.provider || !key.grade) continue;
    updatedVariantKeysMap.set(
      `${key.canonical_slug}::${key.variant_ref}::${key.provider}::${key.grade}`,
      key,
    );
  }
  const updatedVariantKeys = [...updatedVariantKeysMap.values()];
  const updatedVariantKeyCount = updatedVariantKeys.length;
  const updatedVariantKeysForMeta =
    updatedVariantKeyCount <= NIGHTLY_INCREMENTAL_SIGNAL_LIMIT ? updatedVariantKeys : null;
  const updatedVariantKeysHash =
    updatedVariantKeysForMeta === null && updatedVariantKeyCount > 0
      ? crypto.createHash("sha256").update(JSON.stringify(updatedVariantKeys)).digest("hex").slice(0, 16)
      : null;

  if (updatedVariantKeyCount > 0 && updatedVariantKeyCount <= NIGHTLY_INCREMENTAL_SIGNAL_LIMIT) {
    try {
      const { data, error } = await supabase.rpc("refresh_derived_signals_for_variants", {
        keys: updatedVariantKeys,
      });
      if (error) {
        const incrementalError = `refresh_derived_signals_for_variants: ${error.message}`;
        firstError ??= incrementalError;
        const { data: fallbackData, error: fallbackError } = await supabase.rpc("refresh_derived_signals");
        if (fallbackError) {
          firstError ??= `refresh_derived_signals: ${fallbackError.message}`;
        } else {
          signalsRefreshMode = "full";
          signalsRowsUpdatedFull =
            typeof fallbackData === "number"
              ? fallbackData
              : Number((fallbackData as { rowsUpdated?: number; rows?: number } | null)?.rowsUpdated ?? (fallbackData as { rows?: number } | null)?.rows ?? 0);
        }
      } else {
        signalsRefreshMode = "incremental";
        signalsRowsUpdatedIncremental =
          typeof data === "number"
            ? data
            : Number((data as { rowsUpdated?: number; rows?: number } | null)?.rowsUpdated ?? (data as { rows?: number } | null)?.rows ?? 0);
      }
    } catch (err) {
      const incrementalError = `refresh_derived_signals_for_variants: ${err instanceof Error ? err.message : String(err)}`;
      firstError ??= incrementalError;
      try {
        const { data: fallbackData, error: fallbackError } = await supabase.rpc("refresh_derived_signals");
        if (fallbackError) {
          firstError ??= `refresh_derived_signals: ${fallbackError.message}`;
        } else {
          signalsRefreshMode = "full";
          signalsRowsUpdatedFull =
            typeof fallbackData === "number"
              ? fallbackData
              : Number((fallbackData as { rowsUpdated?: number; rows?: number } | null)?.rowsUpdated ?? (fallbackData as { rows?: number } | null)?.rows ?? 0);
        }
      } catch (fallbackErr) {
        firstError ??= `refresh_derived_signals: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`;
      }
    }
  } else if (updatedVariantKeyCount > NIGHTLY_INCREMENTAL_SIGNAL_LIMIT) {
    try {
      const { data, error } = await supabase.rpc("refresh_derived_signals");
      if (error) {
        firstError ??= `refresh_derived_signals: ${error.message}`;
      } else {
        signalsRefreshMode = "full";
        signalsRowsUpdatedFull =
          typeof data === "number"
            ? data
            : Number((data as { rowsUpdated?: number; rows?: number } | null)?.rowsUpdated ?? (data as { rows?: number } | null)?.rows ?? 0);
      }
    } catch (err) {
      firstError ??= `refresh_derived_signals: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (diagnosticsRows.length > 0) {
    const { error } = await supabase.from("tracked_refresh_diagnostics").insert(diagnosticsRows);
    if (error) {
      firstError ??= `tracked_refresh_diagnostics: ${error.message}`;
    }
  }

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
          mode: "nightly",
          trackedOnly,
          limit,
          cursor,
          nextCursor,
          processed,
          skipped,
          failed,
          outboundRequests: requestCount,
          requestCap: NIGHTLY_MAX_REQUESTS_PER_RUN,
          skipReasonCounts,
          skippedSamples,
          updatedVariantKeyCount,
          updatedVariantKeys: updatedVariantKeysForMeta,
          updatedVariantKeysHash,
          marketLatestWritten,
          historyPointsWritten,
          variantMetricsWritten,
          signalsRowsUpdatedIncremental,
          signalsRowsUpdatedFull,
          signalsRefreshMode,
          deprecatedQueryAuth: authDeprecatedQueryAuth,
          firstError,
        },
      })
      .eq("id", runId);
  }

  return NextResponse.json({
    ok: firstError === null,
    mode: "nightly",
    trackedOnly,
    processed,
    skipped,
    failed,
    nextCursor,
    outboundRequests: requestCount,
    requestCap: NIGHTLY_MAX_REQUESTS_PER_RUN,
    skipReasonCounts,
    skippedSamples,
    updatedVariantKeyCount,
    marketLatestWritten,
    historyPointsWritten,
    variantMetricsWritten,
    signalsRowsUpdatedIncremental,
    signalsRowsUpdatedFull,
    signalsRefreshMode,
    firstError,
    deprecatedQueryAuth: authDeprecatedQueryAuth,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode")?.trim() ?? "default";
  const debugSet    = url.searchParams.get("set")?.trim() ?? null;
  const assetFilter = (url.searchParams.get("asset")?.trim() ?? "any") as "sealed" | "single" | "any";
  const sampleMode  = url.searchParams.get("sample") === "1";
  const cardLimit   = parseInt(url.searchParams.get("cardLimit") ?? "0", 10) || null;
  const debugLimit  = parseInt(url.searchParams.get("limit") ?? "0", 10) || null;
  const force       = url.searchParams.get("force") === "1";
  const isDebug     = !!debugSet;

  const supabase = getServerSupabaseClient();
  const now = new Date().toISOString();
  const runDate = now.slice(0, 10); // YYYY-MM-DD

  if (mode === "nightly") {
    const nightlyLimit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? `${NIGHTLY_DEFAULT_LIMIT}`, 10) || NIGHTLY_DEFAULT_LIMIT, NIGHTLY_DEFAULT_LIMIT));
    const nightlyCursor = asNightlyCursor(url.searchParams.get("cursor"));
    const trackedOnly = url.searchParams.get("tracked_only") === "1";
    return runNightlySync({
      req,
      supabase,
      now,
      authDeprecatedQueryAuth: auth.deprecatedQueryAuth,
      limit: nightlyLimit,
      cursor: nightlyCursor,
      trackedOnly,
    });
  }

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

  const { data: allPrintingsRaw } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, card_number, finish, edition, stamp, set_code, set_name")
    .eq("language", "EN")
    .not("canonical_slug", "is", null)
    .limit(50000);

  const allPrintings = (allPrintingsRaw ?? []) as PrintingRow[];

  // In debug mode: process only the explicitly requested set ID.
  // setsToProcess[0] is used for the card_printings lookup (singles path).
  let setsToProcess: OurSet[];
  if (isDebug) {
    const matchedSet =
      allSets.find((set) => setNameToJustTcgId(set.setName) === debugSet) ??
      allSets[0] ??
      null;
    setsToProcess = matchedSet ? [matchedSet] : [];
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
  const allMarketLatestRows: MarketLatestRow[] = [];
  const allHistoryPoints: PriceHistoryPoint[] = [];
  const allVariantMetrics: Record<string, unknown>[] = [];
  const allIngestRows: Record<string, unknown>[] = [];
  const variantAuditRows: Record<string, unknown>[] = [];
  const cardExternalMappingsUpserts: Record<string, unknown>[] = [];
  const mapUpserts: Record<string, unknown>[] = [];
  // Debug only: raw JustTCG envelopes + chosen sample item.
  const debugRawResponses: Array<{ providerSetId: string; httpStatus: number; envelope: unknown }> = [];
  let debugSampleItem: { name: string; assetType: string; canonicalSlug: string; variantRef: string } | null = null;
  let debugLookupSet:
    | { providerSetId: string; canonicalSetCodeForLookup: string; canonicalSetNameForLookup: string }
    | null = null;

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

      const lookupSet =
        isDebug && (cards[0]?.set_name ?? null)
          ? bestSetMatch(cards[0].set_name ?? "", allSets)
          : null;
      const canonicalSetCodeForLookup = lookupSet?.setCode ?? ourSet.setCode;
      const canonicalSetNameForLookup = lookupSet?.setName ?? ourSet.setName;
      if (isDebug) {
        debugLookupSet = {
          providerSetId,
          canonicalSetCodeForLookup,
          canonicalSetNameForLookup,
        };
      }

      // 4. Update provider_set_map confidence.
      const hasCards = cards.length > 0;
      if (canonicalSetCodeForLookup) {
        mapUpserts.push({
          provider: PROVIDER,
          canonical_set_code: canonicalSetCodeForLookup,
          canonical_set_name: canonicalSetNameForLookup,
          provider_set_id: providerSetId,
          confidence: hasCards ? 1.0 : 0.0,
          last_verified_at: hasCards ? now : null,
        });
      }

      if (!hasCards) continue;

      // 5. Choose the most plausible local printings pool for this provider set.
      const providerSetName = cards[0]?.set_name ?? canonicalSetNameForLookup;
      const candidatePrintings = allPrintings.filter((printing) => {
        if (!printing.card_number || !printing.canonical_slug) return false;
        if (!providerSetName || !printing.set_name) {
          return printing.set_code === canonicalSetCodeForLookup;
        }
        return setNamesAreCompatible(providerSetName, printing.set_name);
      });

      const printings = candidatePrintings.length > 0
        ? candidatePrintings
        : allPrintings.filter((printing) => printing.set_code === canonicalSetCodeForLookup);
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
      const maxCardsToScan = isDebug && debugLimit ? debugLimit : cardLimit;
      const cardsToScan: JustTcgCard[] = maxCardsToScan ? cards.slice(0, maxCardsToScan) : cards;
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
          const asOfTs = toProviderObservedAt(sealedVariant.lastUpdated ?? null, now);
          // "sealed" overrides variant.printing; edition/stamp irrelevant for sealed.
          const variantRef = buildLegacyVariantRef("sealed", "unknown", null, sealedVariant.condition, sealedVariant.language ?? "English", "RAW");

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
            ...mapVariantToHistoryPoints(sealedVariant, canonicalSlug, variantRef),
          );

          const sealedMetrics = mapVariantToMetrics(sealedVariant, canonicalSlug, null, "RAW", asOfTs);
          if (sealedMetrics) {
            const historyPointCount = (sealedVariant.priceHistory?.length ?? sealedVariant.priceHistory30d?.length ?? 0);
            allVariantMetrics.push({
              canonical_slug: canonicalSlug,
              printing_id: null,
              variant_ref: variantRef,
              provider: PROVIDER,
              grade: "RAW",
              provider_trend_slope_7d: sealedMetrics.provider_trend_slope_7d,
              provider_cov_price_30d: sealedMetrics.provider_cov_price_30d,
              provider_price_relative_to_30d_range: sealedMetrics.provider_price_relative_to_30d_range,
              provider_price_changes_count_30d: sealedMetrics.provider_price_changes_count_30d,
              provider_as_of_ts: asOfTs,
              history_points_30d: historyPointCount,
              signal_trend: null,
              signal_breakout: null,
              signal_value: null,
              signals_as_of_ts: null,
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
            const variantRef = printing
              ? buildRawVariantRef(printing.id)
              : buildLegacyVariantRef(
                  variant.printing ?? "normal",
                  "UNKNOWN",
                  null,
                  variant.condition,
                  variant.language ?? "English",
                  "RAW",
                );

            if (!printing) {
              allIngestRows.push({
                provider: PROVIDER,
                job: JOB,
                set_id: providerSetId,
                card_id: card.id,
                variant_id: variant.id,
                canonical_slug: null,
                printing_id: null,
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
            }

            // Downstream writes require a printing match.
            if (!printing) continue;
            queuePrintingBackedVariantWrite({
              jobName: JOB,
              providerSetId,
              card,
              variant,
              printing,
              now,
              allIngestRows,
              allPriceSnapshots,
              allMarketLatestRows,
              allHistoryPoints,
              allVariantMetrics,
              variantAuditRows,
              cardExternalMappingsUpserts,
            });

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

  // card_external_mappings (printing-backed JustTCG lookups for nightly refresh)
  if (cardExternalMappingsUpserts.length > 0) {
    for (let i = 0; i < cardExternalMappingsUpserts.length; i += 250) {
      const { error } = await supabase
      .from("card_external_mappings")
      .upsert(cardExternalMappingsUpserts.slice(i, i + 250), { onConflict: "card_id,source,mapping_type" });
      if (error) {
        firstError ??= `card_external_mappings: ${error.message}`;
        break;
      }
    }
  }

  // provider_raw_payloads (trimmed per-mapped-variant audit rows)
  if (variantAuditRows.length > 0) {
    for (let i = 0; i < variantAuditRows.length; i += 250) {
      const { error } = await supabase.from("provider_raw_payloads").insert(variantAuditRows.slice(i, i + 250));
      if (error) {
        firstError ??= `provider_raw_payloads: ${error.message}`;
        break;
      }
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

  // market_latest (cached current market price for Market Summary)
  let marketLatestWritten = 0;
  if (allMarketLatestRows.length > 0) {
    const marketLatestResult = await batchUpsert(
      supabase,
      "market_latest",
      allMarketLatestRows as unknown as Record<string, unknown>[],
      "card_id,source,grade,price_type",
    );
    itemsUpserted += marketLatestResult.upserted;
    itemsFailed += marketLatestResult.failed;
    firstError ??= marketLatestResult.firstError;
    marketLatestWritten = marketLatestResult.upserted;
  }

  // price_history_points (ON CONFLICT DO NOTHING — idempotent)
  let historyPointsWritten = 0;
  if (allHistoryPoints.length > 0) {
    const result = await batchInsertIgnore(
      supabase,
      "price_history_points",
      allHistoryPoints as unknown as Record<string, unknown>[],
      "canonical_slug,variant_ref,provider,ts",
      "ts",
    );
    historyPointsWritten += result.inserted;
    firstError ??= result.firstError;
  }

  const historyCountByVariantRef = new Map<string, number>();
  for (const point of allHistoryPoints) {
    if (point.provider !== PROVIDER || point.source_window !== "30d") continue;
    historyCountByVariantRef.set(point.variant_ref, (historyCountByVariantRef.get(point.variant_ref) ?? 0) + 1);
  }

  for (const row of allVariantMetrics) {
    const variantRef = String(row.variant_ref ?? "");
    if (!variantRef) continue;
    row.history_points_30d = historyCountByVariantRef.get(variantRef) ?? Number(row.history_points_30d ?? 0);
  }

  // refresh_card_metrics() — compute median/volatility stats from price_snapshots
  let metricsRefreshResult: unknown = null;
  try {
    const { data } = await supabase.rpc("refresh_card_metrics");
    metricsRefreshResult = data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    firstError ??= `refresh_card_metrics: ${msg}`;
  }

  // variant_metrics — printing-backed rows upsert on canonical identity,
  // sealed rows keep the legacy variant_ref path until sealed has printing_id.
  const keyedVariantMetrics = allVariantMetrics.filter((row) => row.printing_id);
  const legacyVariantMetrics = allVariantMetrics.filter((row) => !row.printing_id);
  let variantMetricsWritten = 0;

  if (keyedVariantMetrics.length > 0) {
    const result = await batchUpsert(
      supabase,
      "variant_metrics",
      keyedVariantMetrics,
      "canonical_slug,variant_ref,provider,grade",
    );
    itemsUpserted += result.upserted;
    itemsFailed += result.failed;
    firstError ??= result.firstError;
    variantMetricsWritten += result.upserted;
  }

  if (legacyVariantMetrics.length > 0) {
    const result = await batchUpsert(
      supabase,
      "variant_metrics",
      legacyVariantMetrics,
      "canonical_slug,variant_ref,provider,grade",
    );
    itemsUpserted += result.upserted;
    itemsFailed += result.failed;
    firstError ??= result.firstError;
    variantMetricsWritten += result.upserted;
  }

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
          deprecatedQueryAuth: auth.deprecatedQueryAuth,
          firstError,
          marketLatestWritten,
          historyPointsWritten,
          variantMetricsWritten,
        },
      })
      .eq("id", runId);
  }

  const firstDebugResponse = debugRawResponses[0] ?? null;
  const firstDebugEnvelope = firstDebugResponse?.envelope as
    | { data?: JustTcgCard[]; meta?: unknown; _metadata?: unknown }
    | null;
  const debugProviderResponse = firstDebugResponse
    ? {
        providerSetId: firstDebugResponse.providerSetId,
        httpStatus: firstDebugResponse.httpStatus,
        meta: firstDebugEnvelope?.meta ?? null,
        providerMeta: firstDebugEnvelope?._metadata ?? null,
        cards: (firstDebugEnvelope?.data ?? [])
          .slice(0, Math.min(debugLimit ?? 3, 3))
          .map((card) => ({
            id: card.id,
            name: card.name,
            number: card.number,
            variants: (card.variants ?? []).slice(0, 2).map((variant) => ({
              id: variant.id,
              condition: variant.condition,
              printing: variant.printing,
              price: variant.price,
              trendSlope7d: variant.trendSlope7d ?? null,
              covPrice30d: variant.covPrice30d ?? null,
              priceRelativeTo30dRange: variant.priceRelativeTo30dRange ?? null,
              priceChangesCount30d: variant.priceChangesCount30d ?? null,
              historyPoints30d:
                variant.priceHistory?.length ??
                variant.priceHistory30d?.length ??
                0,
            })),
          })),
      }
    : null;

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
    marketLatestWritten,
    historyPointsWritten,
    variantMetricsWritten,
    firstError,
    metricsRefreshResult,
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
    ...(isDebug && {
      debugSampleItem,
      debugProviderResponse,
      debugLookupSet,
      debugVariantMetricRows: allVariantMetrics.slice(0, 10).map((row) => ({
        canonical_slug: row.canonical_slug,
        variant_ref: row.variant_ref,
        provider_as_of_ts: row.provider_as_of_ts,
        history_points_30d: row.history_points_30d,
      })),
    }),
  });
}
