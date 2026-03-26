#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { buildProviderHistoryVariantRef } from "../lib/identity/variant-ref.mjs";

dotenv.config({ path: ".env.local", quiet: true });

const PROVIDER = "SCRYDEX";
const SOURCE_WINDOW = "snapshot";
const PAGE_SIZE = 1000;
const QUERY_CHUNK_SIZE = 100;
const WRITE_CHUNK_SIZE = 500;
const SCRYDEX_2024_PLUS_PROVIDER_SET_IDS = [
  "sv4pt5",
  "sv5",
  "sv6",
  "sv6pt5",
  "sv7",
  "sv8",
  "mcd24",
  "me1",
  "me2",
  "mep",
  "rsv10pt5",
  "sv10",
  "sv8pt5",
  "sv9",
  "zsv10pt5",
  "me2pt5",
];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function createSupabaseFromEnv() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function parseCsvArg(argv, name) {
  return parseStringArg(argv, name, "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function chunkValues(values, size) {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks = [];
  for (let index = 0; index < values.length; index += safeSize) {
    chunks.push(values.slice(index, index + safeSize));
  }
  return chunks;
}

function extractDayKey(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(normalized)) return normalized.replaceAll("/", "-");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function historyDayKeyToSnapshotTs(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new Error(`Invalid day key: ${dayKey}`);
  }
  return `${dayKey}T12:00:00.000Z`;
}

function buildTrailingUtcDayKeys(windowDays, asOfInput = new Date()) {
  const safeWindowDays = Math.max(1, Math.floor(windowDays));
  const parsedAsOf = new Date(asOfInput);
  const asOf = Number.isNaN(parsedAsOf.getTime()) ? new Date() : parsedAsOf;
  const asOfDayMs = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const dayKeys = [];
  for (let offset = safeWindowDays - 1; offset >= 0; offset -= 1) {
    dayKeys.push(new Date(asOfDayMs - (offset * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10));
  }
  return dayKeys;
}

function dedupeBy(values, keyFn) {
  return [...new Map(values.map((value) => [keyFn(value), value])).values()];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableWriteErrorMessage(message) {
  const normalized = normalizeText(message).toLowerCase();
  return normalized.includes("fetch failed")
    || normalized.includes("statement timeout")
    || normalized.includes("timed out")
    || normalized.includes("econnreset")
    || normalized.includes("503")
    || normalized.includes("504");
}

async function retryWriteOperation(label, operation, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
  const baseBackoffMs = Math.max(0, Math.floor(options.baseBackoffMs ?? 400));
  const jitterMs = Math.max(0, Math.floor(options.jitterMs ?? 150));

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableWriteErrorMessage(message) || attempt >= maxAttempts) {
        break;
      }
      const delayMs = baseBackoffMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * (jitterMs + 1));
      console.warn(`${label} attempt ${attempt} failed: ${message}. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
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

function resolveProviderSetIds(argv) {
  const explicit = dedupeBy([
    ...parseCsvArg(argv, "set"),
    ...parseCsvArg(argv, "sets"),
  ], (value) => value);
  if (explicit.length > 0) return explicit;

  const scope = normalizeText(parseStringArg(argv, "scope", "2024plus")).toLowerCase();
  if (!scope || scope === "2024plus") {
    return [...SCRYDEX_2024_PLUS_PROVIDER_SET_IDS];
  }
  throw new Error(`Unknown scope: ${scope}`);
}

async function loadMatchedVariantTargets(supabase, providerSetIds) {
  const rows = [];
  for (const chunk of chunkValues(providerSetIds, QUERY_CHUNK_SIZE)) {
    const chunkRows = await fetchAllRows(supabase, {
      table: "provider_card_map",
      select: "provider_set_id, provider_variant_id, canonical_slug, printing_id",
      filters: [
        { type: "eq", column: "provider", value: PROVIDER },
        { type: "eq", column: "mapping_status", value: "MATCHED" },
        { type: "in", column: "provider_set_id", value: chunk },
      ],
      orders: [
        { column: "provider_set_id", ascending: true },
        { column: "canonical_slug", ascending: true },
        { column: "provider_variant_id", ascending: true },
      ],
    });
    rows.push(...chunkRows);
  }

  return dedupeBy(rows
    .map((row) => {
      const providerSetId = normalizeText(row.provider_set_id);
      const providerVariantId = normalizeText(row.provider_variant_id);
      const canonicalSlug = normalizeText(row.canonical_slug);
      const printingId = normalizeText(row.printing_id) || null;
      if (!providerSetId || !providerVariantId || !canonicalSlug) return null;
      return {
        providerSetId,
        providerVariantId,
        canonicalSlug,
        printingId,
        variantRef: buildProviderHistoryVariantRef({
          printingId,
          canonicalSlug,
          provider: PROVIDER,
          providerVariantId,
        }),
      };
    })
    .filter(Boolean), (row) => `${row.providerSetId}::${row.variantRef}`);
}

async function loadSnapshotHistoryRows(supabase, variantRefs, sinceIso, asOfIso) {
  const rows = [];
  for (const chunk of chunkValues(variantRefs, QUERY_CHUNK_SIZE)) {
    const chunkRows = await fetchAllRows(supabase, {
      table: "price_history_points",
      select: "canonical_slug, variant_ref, ts, price, currency",
      filters: [
        { type: "eq", column: "provider", value: PROVIDER },
        { type: "eq", column: "source_window", value: SOURCE_WINDOW },
        { type: "in", column: "variant_ref", value: chunk },
        { type: "gte", column: "ts", value: sinceIso },
        { type: "lte", column: "ts", value: asOfIso },
      ],
      orders: [
        { column: "variant_ref", ascending: true },
        { column: "ts", ascending: true },
      ],
    });
    rows.push(...chunkRows);
  }
  return rows;
}

function buildForwardFillRows(params) {
  const actualRowsByDayKey = new Map();
  for (const row of params.actualRows) {
    const dayKey = extractDayKey(row.ts);
    if (!dayKey) continue;
    actualRowsByDayKey.set(dayKey, {
      dayKey,
      price: Number(row.price),
      currency: normalizeText(row.currency) || "USD",
    });
  }

  const fillRows = [];
  const actualDayKeys = new Set(actualRowsByDayKey.keys());
  let carryForward = null;

  for (const dayKey of buildTrailingUtcDayKeys(params.windowDays, params.asOf)) {
    const actual = actualRowsByDayKey.get(dayKey) ?? null;
    if (actual) {
      carryForward = actual;
      continue;
    }
    if (carryForward === null) continue;
    fillRows.push({
      canonical_slug: params.canonicalSlug,
      variant_ref: params.variantRef,
      provider: PROVIDER,
      ts: historyDayKeyToSnapshotTs(dayKey),
      price: carryForward.price,
      currency: carryForward.currency,
      source_window: SOURCE_WINDOW,
      fill_source: "carry_forward",
    });
  }

  return {
    actualDayKeys,
    fillRows,
  };
}

function ensureCoverageBucket(map, key) {
  const existing = map.get(key);
  if (existing) return existing;
  const created = {
    beforeDays: new Set(),
    afterDays: new Set(),
  };
  map.set(key, created);
  return created;
}

function summarizeFreshCards(coverageByCanonical, windowDays) {
  let freshBefore = 0;
  let freshAfter = 0;
  for (const coverage of coverageByCanonical.values()) {
    if (coverage.beforeDays.size >= windowDays) freshBefore += 1;
    if (coverage.afterDays.size >= windowDays) freshAfter += 1;
  }
  return { freshBefore, freshAfter };
}

async function main() {
  const providerSetIds = resolveProviderSetIds(process.argv);
  const windowDays = parseIntArg(process.argv, "days", 30);
  const asOfInput = parseStringArg(process.argv, "as-of", "").trim() || new Date().toISOString();
  const dryRun = !parseBoolFlag(process.argv, "write");
  const supabase = createSupabaseFromEnv();

  const asOf = new Date(asOfInput);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid --as-of value: ${asOfInput}`);
  }

  const windowDayKeys = buildTrailingUtcDayKeys(windowDays, asOf);
  const sinceIso = historyDayKeyToSnapshotTs(windowDayKeys[0]);
  const asOfIso = new Date(Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate(),
    23,
    59,
    59,
    999,
  )).toISOString();

  const targets = await loadMatchedVariantTargets(supabase, providerSetIds);
  const variantRefs = dedupeBy(targets.map((target) => target.variantRef).filter(Boolean), (value) => value);
  const historyRows = variantRefs.length > 0
    ? await loadSnapshotHistoryRows(supabase, variantRefs, sinceIso, asOfIso)
    : [];

  const rowsByVariantRef = new Map();
  for (const row of historyRows) {
    const variantRef = normalizeText(row.variant_ref);
    if (!variantRef) continue;
    const bucket = rowsByVariantRef.get(variantRef) ?? [];
    bucket.push(row);
    rowsByVariantRef.set(variantRef, bucket);
  }

  const perSet = new Map();
  const overallCoverage = new Map();
  const preparedRows = [];
  let variantsWithSnapshotCoverage = 0;
  let variantsForwardFilled = 0;

  for (const target of targets) {
    const setBucket = perSet.get(target.providerSetId) ?? {
      providerSetId: target.providerSetId,
      matchedVariants: 0,
      variantsWithSnapshotCoverage: 0,
      variantsForwardFilled: 0,
      rowsPrepared: 0,
      coverageByCanonical: new Map(),
    };
    setBucket.matchedVariants += 1;

    const actualRows = rowsByVariantRef.get(target.variantRef) ?? [];
    const resolved = buildForwardFillRows({
      canonicalSlug: target.canonicalSlug,
      variantRef: target.variantRef,
      actualRows,
      windowDays,
      asOf,
    });

    if (resolved.actualDayKeys.size > 0) {
      variantsWithSnapshotCoverage += 1;
      setBucket.variantsWithSnapshotCoverage += 1;
    }
    if (resolved.fillRows.length > 0) {
      variantsForwardFilled += 1;
      setBucket.variantsForwardFilled += 1;
      setBucket.rowsPrepared += resolved.fillRows.length;
      preparedRows.push(...resolved.fillRows);
    }

    const setCoverage = ensureCoverageBucket(setBucket.coverageByCanonical, target.canonicalSlug);
    const overallBucket = ensureCoverageBucket(overallCoverage, target.canonicalSlug);
    for (const dayKey of resolved.actualDayKeys) {
      setCoverage.beforeDays.add(dayKey);
      setCoverage.afterDays.add(dayKey);
      overallBucket.beforeDays.add(dayKey);
      overallBucket.afterDays.add(dayKey);
    }
    for (const row of resolved.fillRows) {
      const dayKey = extractDayKey(row.ts);
      if (!dayKey) continue;
      setCoverage.afterDays.add(dayKey);
      overallBucket.afterDays.add(dayKey);
    }

    perSet.set(target.providerSetId, setBucket);
  }

  const dedupedRows = dedupeBy(preparedRows, (row) => `${row.provider}|${row.variant_ref}|${row.ts}|${row.source_window}`);
  let rowsUpserted = 0;

  if (!dryRun && dedupedRows.length > 0) {
    const writeChunks = chunkValues(dedupedRows, WRITE_CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < writeChunks.length; chunkIndex += 1) {
      const chunk = writeChunks[chunkIndex];
      const payload = chunk.map(({ fill_source, ...row }) => row);
      const data = await retryWriteOperation(
        `price_history_points(upsert fill rows ${chunkIndex + 1}/${writeChunks.length})`,
        async () => {
          const { data, error } = await supabase
            .from("price_history_points")
            .upsert(payload, { onConflict: "provider,variant_ref,ts,source_window" })
            .select("id");
          if (error) throw new Error(error.message);
          return data ?? [];
        },
      );
      rowsUpserted += (data ?? []).length;
    }
  }

  const summarizedSets = [...perSet.values()]
    .map((row) => {
      const matchedCards = row.coverageByCanonical.size;
      const freshCounts = summarizeFreshCards(row.coverageByCanonical, windowDays);
      return {
        providerSetId: row.providerSetId,
        matchedVariants: row.matchedVariants,
        matchedCards,
        variantsWithSnapshotCoverage: row.variantsWithSnapshotCoverage,
        variantsForwardFilled: row.variantsForwardFilled,
        rowsPrepared: row.rowsPrepared,
        freshCardsBefore: freshCounts.freshBefore,
        freshCardsAfter: freshCounts.freshAfter,
      };
    })
    .sort((left, right) => right.rowsPrepared - left.rowsPrepared || left.providerSetId.localeCompare(right.providerSetId));

  const overallFreshCounts = summarizeFreshCards(overallCoverage, windowDays);
  const result = {
    ok: true,
    provider: PROVIDER,
    sourceWindow: SOURCE_WINDOW,
    dryRun,
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    windowDays,
    providerSetIds,
    matchedVariants: targets.length,
    matchedCards: overallCoverage.size,
    variantsWithSnapshotCoverage,
    variantsForwardFilled,
    rowsPrepared: dedupedRows.length,
    rowsUpserted,
    freshCardsBefore: overallFreshCounts.freshBefore,
    freshCardsAfter: overallFreshCounts.freshAfter,
    perSet: summarizedSets,
    sampleWrites: dedupedRows.slice(0, 25),
  };

  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
