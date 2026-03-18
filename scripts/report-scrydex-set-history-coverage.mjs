#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const PROVIDER = "SCRYDEX";
const ENDPOINT = "/en/expansions/{id}/cards";
const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 200;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseStringArg(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseIntArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export function createSupabaseFromEnv() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function fetchAllRows(supabase, options) {
  const {
    table,
    select,
    filters = [],
    orders = [],
    pageSize = PAGE_SIZE,
  } = options;

  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(select);
    for (const filter of filters) {
      if (filter.type === "eq") query = query.eq(filter.column, filter.value);
      else if (filter.type === "in") query = query.in(filter.column, filter.value);
      else if (filter.type === "gte") query = query.gte(filter.column, filter.value);
      else if (filter.type === "lte") query = query.lte(filter.column, filter.value);
      else if (filter.type === "contains") query = query.contains(filter.column, filter.value);
    }
    for (const order of orders) {
      query = query.order(order.column, { ascending: order.ascending !== false });
    }
    query = query.range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

function normalizeProviderSetId(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const raw = params.expansionId;
  return String(raw ?? "").trim();
}

function variantRefForPrinting(printingId, providerVariantId) {
  const normalizedPrintingId = String(printingId ?? "").trim();
  const normalizedVariantId = String(providerVariantId ?? "").trim();
  if (!normalizedPrintingId || !normalizedVariantId) return "";
  return `${normalizedPrintingId}::${normalizedVariantId}::RAW`;
}

function variantLabel(providerVariantId) {
  const raw = String(providerVariantId ?? "").trim();
  if (!raw) return "";
  return raw.split(":").at(-1) ?? raw;
}

function uniqueSortedTimestamps(rows) {
  const timestamps = new Set();
  for (const row of rows) {
    const ts = String(row?.ts ?? "").trim();
    if (ts) timestamps.add(ts);
  }
  return [...timestamps].sort();
}

function uniqueSortedDayKeys(rows) {
  const dayKeys = new Set();
  for (const row of rows) {
    const ts = String(row?.ts ?? "").trim();
    const dayKey = ts.slice(0, 10);
    if (dayKey) dayKeys.add(dayKey);
  }
  return [...dayKeys].sort();
}

function countDistinctDaysWithinDays(rows, days, nowMs) {
  const cutoffMs = nowMs - (days * 24 * 60 * 60 * 1000);
  let count = 0;
  for (const dayKey of uniqueSortedDayKeys(rows)) {
    const tsMs = Date.parse(`${dayKey}T12:00:00.000Z`);
    if (Number.isFinite(tsMs) && tsMs >= cutoffMs) count += 1;
  }
  return count;
}

function compareByHistoryDesc(left, right) {
  if (right.livePoints90d !== left.livePoints90d) return right.livePoints90d - left.livePoints90d;
  if (right.livePoints30d !== left.livePoints30d) return right.livePoints30d - left.livePoints30d;
  return String(left.providerVariantId).localeCompare(String(right.providerVariantId));
}

export async function loadRetainedPayloads(supabase, params) {
  const rows = await fetchAllRows(supabase, {
    table: "provider_raw_payloads",
    select: "id, fetched_at, params, status_code",
    filters: [
      { type: "eq", column: "provider", value: PROVIDER },
      { type: "eq", column: "endpoint", value: ENDPOINT },
      { type: "contains", column: "params", value: { expansionId: params.providerSetId } },
    ],
    orders: [
      { column: "fetched_at", ascending: true },
      { column: "id", ascending: true },
    ],
  });

  const sinceMs = params.sinceIso ? Date.parse(params.sinceIso) : Number.NaN;
  return rows.filter((row) => {
    if (normalizeProviderSetId(row.params) !== params.providerSetId) return false;
    const statusCode = Number(row.status_code ?? 0);
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) return false;
    if (Number.isFinite(sinceMs)) {
      const fetchedAtMs = Date.parse(String(row.fetched_at ?? ""));
      if (!Number.isFinite(fetchedAtMs) || fetchedAtMs < sinceMs) return false;
    }
    return true;
  });
}

async function loadPriceHistoryRowsByVariantRefs(supabase, variantRefs, sinceIso) {
  const rows = [];
  for (let start = 0; start < variantRefs.length; start += IN_CHUNK_SIZE) {
    const chunk = variantRefs.slice(start, start + IN_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const chunkRows = await fetchAllRows(supabase, {
      table: "price_history_points",
      select: "canonical_slug, variant_ref, ts, source_window",
      filters: [
        { type: "eq", column: "provider", value: PROVIDER },
        { type: "in", column: "variant_ref", value: chunk },
        { type: "gte", column: "ts", value: sinceIso },
      ],
      orders: [
        { column: "ts", ascending: true },
      ],
    });
    rows.push(...chunkRows);
  }
  return rows;
}

export async function loadSetHistoryCoverage(supabase, params) {
  const providerSetId = String(params.providerSetId ?? "").trim();
  if (!providerSetId) throw new Error("providerSetId is required");

  const canonicalSlugFilter = String(params.slug ?? "").trim() || null;
  const nowMs = Date.now();
  const ninetyDaysAgoIso = new Date(nowMs - (90 * 24 * 60 * 60 * 1000)).toISOString();

  const [retainedPayloads, matchedRows, normalizedObservationRows, providerSetHealthRows] = await Promise.all([
    loadRetainedPayloads(supabase, { providerSetId, sinceIso: params.sinceIso ?? null }),
    fetchAllRows(supabase, {
      table: "provider_card_map",
      select: "provider_card_id, provider_variant_id, canonical_slug, printing_id, updated_at",
      filters: [
        { type: "eq", column: "provider", value: PROVIDER },
        { type: "eq", column: "provider_set_id", value: providerSetId },
        { type: "eq", column: "mapping_status", value: "MATCHED" },
      ],
      orders: [
        { column: "canonical_slug", ascending: true },
        { column: "provider_variant_id", ascending: true },
      ],
    }),
    fetchAllRows(supabase, {
      table: "provider_normalized_observations",
      select: "provider_variant_id, observed_at",
      filters: [
        { type: "eq", column: "provider", value: PROVIDER },
        { type: "eq", column: "provider_set_id", value: providerSetId },
      ],
      orders: [
        { column: "observed_at", ascending: true },
      ],
    }),
    fetchAllRows(supabase, {
      table: "provider_set_health",
      select: "provider_set_id, last_success_at, last_attempt_at, requests_last_run, pages_last_run, cards_last_run, last_status_code, last_error, updated_at",
      filters: [
        { type: "eq", column: "provider", value: PROVIDER },
        { type: "eq", column: "provider_set_id", value: providerSetId },
      ],
      orders: [
        { column: "updated_at", ascending: false },
      ],
      pageSize: 5,
    }),
  ]);

  const scopedMatchedRows = canonicalSlugFilter
    ? matchedRows.filter((row) => String(row.canonical_slug ?? "").trim() === canonicalSlugFilter)
    : matchedRows;

  const variantRefs = scopedMatchedRows
    .map((row) => variantRefForPrinting(row.printing_id, row.provider_variant_id))
    .filter(Boolean);

  const historyRows = variantRefs.length > 0
    ? await loadPriceHistoryRowsByVariantRefs(supabase, variantRefs, ninetyDaysAgoIso)
    : [];

  const observationsByVariant = new Map();
  for (const row of normalizedObservationRows) {
    const providerVariantId = String(row.provider_variant_id ?? "").trim();
    if (!providerVariantId) continue;
    const bucket = observationsByVariant.get(providerVariantId) ?? [];
    bucket.push({ observed_at: row.observed_at });
    observationsByVariant.set(providerVariantId, bucket);
  }

  const historyByVariantRef = new Map();
  for (const row of historyRows) {
    const variantRef = String(row.variant_ref ?? "").trim();
    if (!variantRef) continue;
    const bucket = historyByVariantRef.get(variantRef) ?? [];
    bucket.push(row);
    historyByVariantRef.set(variantRef, bucket);
  }

  const printingRows = scopedMatchedRows.map((row) => {
    const providerVariantId = String(row.provider_variant_id ?? "").trim();
    const canonicalSlug = String(row.canonical_slug ?? "").trim();
    const printingId = String(row.printing_id ?? "").trim();
    const variantRef = variantRefForPrinting(printingId, providerVariantId);
    const normalizedRows = observationsByVariant.get(providerVariantId) ?? [];
    const historyRowsForVariant = historyByVariantRef.get(variantRef) ?? [];
    const snapshotRows = historyRowsForVariant.filter((historyRow) => String(historyRow.source_window ?? "") === "snapshot");
    const normalizedObservedAt = uniqueSortedTimestamps(
      normalizedRows.map((item) => ({ ts: item.observed_at })),
    );
    const normalizedObservedDays = uniqueSortedDayKeys(
      normalizedRows.map((item) => ({ ts: item.observed_at })),
    );
    const latestObservedAt = normalizedObservedAt.at(-1) ?? null;
    const latestHistoryTs = uniqueSortedTimestamps(historyRowsForVariant).at(-1) ?? null;

    return {
      canonicalSlug,
      printingId,
      providerCardId: String(row.provider_card_id ?? "").trim(),
      providerVariantId,
      label: variantLabel(providerVariantId),
      normalizedObservationCount: normalizedObservedDays.length,
      snapshotPoints7d: countDistinctDaysWithinDays(snapshotRows, 7, nowMs),
      snapshotPoints30d: countDistinctDaysWithinDays(snapshotRows, 30, nowMs),
      snapshotPoints90d: countDistinctDaysWithinDays(snapshotRows, 90, nowMs),
      livePoints7d: countDistinctDaysWithinDays(historyRowsForVariant, 7, nowMs),
      livePoints30d: countDistinctDaysWithinDays(historyRowsForVariant, 30, nowMs),
      livePoints90d: countDistinctDaysWithinDays(historyRowsForVariant, 90, nowMs),
      latestObservedAt,
      latestHistoryTs,
    };
  }).sort(compareByHistoryDesc);

  const canonicalBySlug = new Map();
  for (const row of printingRows) {
    const bucket = canonicalBySlug.get(row.canonicalSlug) ?? [];
    bucket.push(row);
    canonicalBySlug.set(row.canonicalSlug, bucket);
  }

  const canonicalCards = [...canonicalBySlug.entries()]
    .map(([canonicalSlug, rows]) => {
      const allHistoryRows = rows.flatMap((row) => historyByVariantRef.get(variantRefForPrinting(row.printingId, row.providerVariantId)) ?? []);
      return {
        canonicalSlug,
        matchedPrintings: rows.length,
        livePoints7d: countDistinctDaysWithinDays(allHistoryRows, 7, nowMs),
        livePoints30d: countDistinctDaysWithinDays(allHistoryRows, 30, nowMs),
        livePoints90d: countDistinctDaysWithinDays(allHistoryRows, 90, nowMs),
      };
    })
    .sort((left, right) => {
      if (right.livePoints90d !== left.livePoints90d) return right.livePoints90d - left.livePoints90d;
      if (right.livePoints30d !== left.livePoints30d) return right.livePoints30d - left.livePoints30d;
      return left.canonicalSlug.localeCompare(right.canonicalSlug);
    });

  const latestHealth = providerSetHealthRows[0] ?? null;

  return {
    ok: true,
    provider: PROVIDER,
    providerSetId,
    slug: canonicalSlugFilter,
    generatedAt: new Date().toISOString(),
    retainedPayloads: {
      count: retainedPayloads.length,
      oldestFetchedAt: retainedPayloads[0]?.fetched_at ?? null,
      newestFetchedAt: retainedPayloads.at(-1)?.fetched_at ?? null,
    },
    providerSetHealth: latestHealth,
    matchedPrintingCount: printingRows.length,
    canonicalCardCount: canonicalCards.length,
    printingRows,
    canonicalCards,
  };
}

export function buildCoverageSummary(report, top = 10) {
  return {
    ok: report.ok,
    provider: report.provider,
    providerSetId: report.providerSetId,
    slug: report.slug,
    generatedAt: report.generatedAt,
    retainedPayloads: report.retainedPayloads,
    providerSetHealth: report.providerSetHealth,
    matchedPrintingCount: report.matchedPrintingCount,
    canonicalCardCount: report.canonicalCardCount,
    canonicalCards: report.canonicalCards.slice(0, top),
    printingRows: report.slug ? report.printingRows : report.printingRows.slice(0, top),
  };
}

async function main() {
  const providerSetId = parseStringArg(process.argv, "set", "").trim();
  if (!providerSetId) {
    throw new Error("Usage: node scripts/report-scrydex-set-history-coverage.mjs --set=<provider_set_id> [--slug=<canonical_slug>] [--top=<count>] [--since=<iso>]");
  }

  const slug = parseStringArg(process.argv, "slug", "").trim() || null;
  const top = parseIntArg(process.argv, "top", 10);
  const sinceIso = parseStringArg(process.argv, "since", "").trim() || null;
  const supabase = createSupabaseFromEnv();
  const report = await loadSetHistoryCoverage(supabase, { providerSetId, slug, sinceIso });
  console.log(JSON.stringify(buildCoverageSummary(report, top), null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
