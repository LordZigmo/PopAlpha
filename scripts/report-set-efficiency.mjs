#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildSetId } from "../lib/sets/summary-core.mjs";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_PROVIDER = "SCRYDEX";
const DEFAULT_BUDGET = 20000;
const DEFAULT_TOP = 25;
const PAGE_SIZE = 1000;
const RAW_GRADE = "RAW";
const FRESH_WINDOW_HOURS = 24;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseIntArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringArg(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeProvider(value) {
  return String(value ?? DEFAULT_PROVIDER).trim().toUpperCase() || DEFAULT_PROVIDER;
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US");
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

function hoursSince(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return round((Date.now() - ms) / (1000 * 60 * 60), 1);
}

function calcPct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return round((numerator / denominator) * 100, 1);
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
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
      else if (filter.type === "gte") query = query.gte(filter.column, filter.value);
      else if (filter.type === "lte") query = query.lte(filter.column, filter.value);
      else if (filter.type === "notIs") query = query.not(filter.column, "is", null);
      else if (filter.type === "in") query = query.in(filter.column, filter.value);
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

function ensureEntry(entryByKey, key, partial = {}) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) return null;
  let entry = entryByKey.get(normalizedKey);
  if (!entry) {
    entry = {
      key: normalizedKey,
      providerSetId: null,
      setCode: null,
      setName: null,
      setId: null,
      year: null,
      mapConfidence: null,
      requestsLastRun: 0,
      pagesLastRun: 0,
      cardsLastRun: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastStatusCode: null,
      lastError: null,
      cooldownUntil: null,
      nextRetryAt: null,
      totalPrintings: 0,
      canonicalSlugSet: new Set(),
      pricedCanonicalSlugSet: new Set(),
      freshCanonicalSlugSet: new Set(),
      pricedVariantRows: 0,
      freshVariantRows24h: 0,
      observationCount30dSum: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      recommendation: "UNCLASSIFIED",
      priorityScore: 0,
      nextBatchRequests: 0,
    };
    entryByKey.set(normalizedKey, entry);
  }

  if (partial.providerSetId && !entry.providerSetId) entry.providerSetId = partial.providerSetId;
  if (partial.setCode && !entry.setCode) entry.setCode = partial.setCode;
  if (partial.setName && !entry.setName) entry.setName = partial.setName;
  if (partial.setId && !entry.setId) entry.setId = partial.setId;
  if (partial.year != null && entry.year == null) entry.year = partial.year;
  if (partial.year != null && entry.year != null) entry.year = Math.max(entry.year, partial.year);
  if (partial.mapConfidence != null) entry.mapConfidence = partial.mapConfidence;
  return entry;
}

function classifyEntry(entry, nowMs) {
  const pricedCards = entry.pricedCanonicalCards;
  const requests = entry.requestsLastRun;
  const cardsLastRun = entry.cardsLastRun;
  const matched = entry.matchedCount;
  const unmatched = entry.unmatchedCount;
  const freshPct = entry.freshCoveragePct == null ? 0 : entry.freshCoveragePct / 100;
  const inCooldown = [entry.cooldownUntil, entry.nextRetryAt]
    .filter(Boolean)
    .some((value) => {
      const ms = Date.parse(value);
      return Number.isFinite(ms) && ms > nowMs;
    });

  if (!entry.providerSetId) return "NO_PROVIDER_MAP";
  if (inCooldown) return "WAIT_COOLDOWN";
  if (cardsLastRun > 0 && pricedCards === 0) {
    if ((matched + unmatched) > 0 && matched <= unmatched) return "HOLD_MATCHING";
    return "HOLD_ZERO_PRICE";
  }
  if (requests > 0 && cardsLastRun === 0) return "HOLD_EMPTY_FETCH";
  if (pricedCards > 0 && freshPct < 0.2) return "SCALE";
  if (pricedCards > 0 && freshPct < 0.6) return "KEEP_WARM";
  if (pricedCards > 0) return "DEPRIORITIZE";
  return "TEST_SMALL";
}

function scoreEntry(entry) {
  const totalCards = Math.max(0, entry.totalCanonicalCards);
  const pricedCards = Math.max(0, entry.pricedCanonicalCards);
  const freshCards = Math.max(0, entry.freshCanonicalCards24h);
  const requests = Math.max(1, entry.requestsLastRun || 3);
  const matchRate = entry.matchRatePct == null ? (pricedCards > 0 ? 0.75 : 0.5) : (entry.matchRatePct / 100);
  const recentBoost = entry.year != null && entry.year >= 2025
    ? 1.35
    : entry.year != null && entry.year >= 2024
      ? 1.15
      : 1;
  const sizeBoost = Math.log2(totalCards + 2);
  const freshGapCards = Math.max(totalCards - freshCards, 0);
  const pricedPerRequest = pricedCards / requests;
  const freshPerRequest = freshCards / requests;

  if (entry.recommendation === "SCALE") {
    return round((freshGapCards + 1) * sizeBoost * (0.5 + matchRate) * recentBoost * Math.max(freshPerRequest, pricedPerRequest * 0.4), 3) ?? 0;
  }
  if (entry.recommendation === "KEEP_WARM") {
    return round(sizeBoost * recentBoost * Math.max(pricedPerRequest, 0.1) * (0.5 + matchRate), 3) ?? 0;
  }
  if (entry.recommendation === "TEST_SMALL") {
    return round(sizeBoost * recentBoost * 0.2, 3) ?? 0;
  }
  return 0;
}

function nextBatchRequests(entry) {
  if (entry.recommendation === "SCALE") {
    return Math.min(10, Math.max(3, entry.requestsLastRun || entry.pagesLastRun || 3));
  }
  if (entry.recommendation === "KEEP_WARM") {
    return Math.min(4, Math.max(1, Math.ceil((entry.requestsLastRun || 2) / 2)));
  }
  if (entry.recommendation === "TEST_SMALL") {
    return 2;
  }
  return 0;
}

function sortEntries(rows) {
  const rank = {
    SCALE: 1,
    KEEP_WARM: 2,
    TEST_SMALL: 3,
    WAIT_COOLDOWN: 4,
    HOLD_MATCHING: 5,
    HOLD_ZERO_PRICE: 6,
    HOLD_EMPTY_FETCH: 7,
    NO_PROVIDER_MAP: 8,
    DEPRIORITIZE: 9,
    UNCLASSIFIED: 10,
  };
  return [...rows].sort((left, right) => {
    const leftRank = rank[left.recommendation] ?? 99;
    const rightRank = rank[right.recommendation] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (right.priorityScore !== left.priorityScore) return right.priorityScore - left.priorityScore;
    if ((right.year ?? 0) !== (left.year ?? 0)) return (right.year ?? 0) - (left.year ?? 0);
    return String(left.setCode ?? left.setName ?? left.providerSetId ?? "")
      .localeCompare(String(right.setCode ?? right.setName ?? right.providerSetId ?? ""));
  });
}

function rowsToMarkdown(rows, summary, options) {
  const lines = [];
  lines.push(`# ${options.provider} Set Efficiency Report`);
  lines.push("");
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Budget input: ${formatNumber(summary.budgetRequests)} requests`);
  lines.push(`- Sets analyzed: ${formatNumber(summary.setCount)}`);
  lines.push(`- Immediate recommended spend: ${formatNumber(summary.immediateRequests)} requests`);
  lines.push(`- Reserve after immediate batch: ${formatNumber(summary.reserveRequests)} requests`);
  lines.push(`- Proven priced sets: ${formatNumber(summary.provenPricedSetCount)}`);
  lines.push(`- Hold sets (zero-price/matching/fetch/cooldown): ${formatNumber(summary.holdSetCount)}`);
  lines.push("");
  lines.push("| Recommendation | Set | Year | Provider Set | Total Cards | Priced | Fresh 24h | Coverage | Match Rate | Last Run Req | Fresh/Req | Next Batch | Score |");
  lines.push("|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    const label = row.setCode ?? row.setName ?? row.providerSetId ?? row.key;
    lines.push(
      `| ${escapeCell(row.recommendation)} | ${escapeCell(label)} | ${escapeCell(row.year ?? "-")} | ${escapeCell(row.providerSetId ?? "-")} | ${escapeCell(formatNumber(row.totalCanonicalCards))} | ${escapeCell(formatNumber(row.pricedCanonicalCards))} | ${escapeCell(formatNumber(row.freshCanonicalCards24h))} | ${escapeCell(formatPct(row.coveragePct))} | ${escapeCell(formatPct(row.matchRatePct))} | ${escapeCell(formatNumber(row.requestsLastRun))} | ${escapeCell(row.freshCardsPerRequest == null ? "-" : row.freshCardsPerRequest.toFixed(2))} | ${escapeCell(formatNumber(row.nextBatchRequests))} | ${escapeCell(row.priorityScore.toFixed(3))} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const provider = normalizeProvider(parseStringArg(argv, "provider", DEFAULT_PROVIDER));
  const yearFrom = parseIntArg(argv, "year-from", null);
  const yearTo = parseIntArg(argv, "year-to", null);
  const budgetRequests = Math.max(0, parseIntArg(argv, "budget", DEFAULT_BUDGET));
  const top = Math.max(1, parseIntArg(argv, "top", DEFAULT_TOP));
  const format = parseStringArg(argv, "format", "markdown").trim().toLowerCase();
  const outPath = parseStringArg(argv, "out", "").trim();

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const nowMs = Date.now();
  const freshCutoffIso = new Date(nowMs - (FRESH_WINDOW_HOURS * 60 * 60 * 1000)).toISOString();
  const entryByKey = new Map();
  const entryBySetId = new Map();
  const entryByProviderSetId = new Map();

  const cardPrintingFilters = [
    { type: "eq", column: "language", value: "EN" },
    { type: "notIs", column: "set_code" },
  ];
  if (yearFrom != null) cardPrintingFilters.push({ type: "gte", column: "year", value: yearFrom });
  if (yearTo != null) cardPrintingFilters.push({ type: "lte", column: "year", value: yearTo });

  const [
    cardPrintingRows,
    providerSetMapRows,
    providerSetHealthRows,
    variantPriceRows,
    matchRows,
  ] = await Promise.all([
    fetchAllRows(supabase, {
      table: "card_printings",
      select: "set_code,set_name,year,canonical_slug",
      filters: cardPrintingFilters,
      orders: [{ column: "id" }],
    }),
    fetchAllRows(supabase, {
      table: "provider_set_map",
      select: "canonical_set_code,canonical_set_name,provider_set_id,confidence",
      filters: [{ type: "eq", column: "provider", value: provider }],
      orders: [{ column: "canonical_set_code" }],
    }),
    fetchAllRows(supabase, {
      table: "provider_set_health",
      select: "provider_set_id,canonical_set_code,canonical_set_name,last_attempt_at,last_success_at,last_status_code,last_error,cooldown_until,next_retry_at,requests_last_run,pages_last_run,cards_last_run",
      filters: [{ type: "eq", column: "provider", value: provider }],
      orders: [{ column: "provider_set_id" }],
    }),
    fetchAllRows(supabase, {
      table: "variant_price_latest",
      select: "set_id,set_name,canonical_slug,latest_observed_at,observation_count_30d",
      filters: [
        { type: "eq", column: "provider", value: provider },
        { type: "eq", column: "grade", value: RAW_GRADE },
      ],
      orders: [{ column: "set_id" }, { column: "canonical_slug" }],
    }),
    fetchAllRows(supabase, {
      table: "provider_observation_matches",
      select: "provider_set_id,match_status",
      filters: [{ type: "eq", column: "provider", value: provider }],
      orders: [{ column: "provider_set_id" }, { column: "provider_variant_id" }],
    }),
  ]);

  for (const row of cardPrintingRows) {
    const setCode = String(row.set_code ?? "").trim();
    if (!setCode) continue;
    const setName = String(row.set_name ?? "").trim() || setCode;
    const setId = buildSetId(setName);
    const entry = ensureEntry(entryByKey, setCode, {
      setCode,
      setName,
      setId,
      year: typeof row.year === "number" ? row.year : null,
    });
    if (!entry) continue;
    entry.totalPrintings += 1;
    if (row.canonical_slug) entry.canonicalSlugSet.add(row.canonical_slug);
    if (setId && !entryBySetId.has(setId)) entryBySetId.set(setId, entry);
  }

  for (const row of providerSetMapRows) {
    const setCode = String(row.canonical_set_code ?? "").trim() || `provider:${row.provider_set_id}`;
    const setName = String(row.canonical_set_name ?? "").trim() || setCode;
    const setId = buildSetId(setName);
    const entry = ensureEntry(entryByKey, setCode, {
      setCode: row.canonical_set_code ?? setCode,
      setName,
      setId,
      providerSetId: row.provider_set_id ?? null,
      mapConfidence: typeof row.confidence === "number" ? row.confidence : null,
    });
    if (!entry) continue;
    if (row.provider_set_id) entryByProviderSetId.set(row.provider_set_id, entry);
    if (setId && !entryBySetId.has(setId)) entryBySetId.set(setId, entry);
  }

  for (const row of providerSetHealthRows) {
    const fallbackKey = String(row.canonical_set_code ?? "").trim() || `provider:${row.provider_set_id}`;
    const setName = String(row.canonical_set_name ?? "").trim() || fallbackKey;
    const setId = buildSetId(setName);
    const existing = row.provider_set_id ? entryByProviderSetId.get(row.provider_set_id) : null;
    const entry = existing ?? ensureEntry(entryByKey, fallbackKey, {
      setCode: row.canonical_set_code ?? null,
      setName,
      setId,
      providerSetId: row.provider_set_id ?? null,
    });
    if (!entry) continue;
    entry.providerSetId = row.provider_set_id ?? entry.providerSetId;
    entry.lastAttemptAt = row.last_attempt_at ?? null;
    entry.lastSuccessAt = row.last_success_at ?? null;
    entry.lastStatusCode = row.last_status_code ?? null;
    entry.lastError = row.last_error ?? null;
    entry.cooldownUntil = row.cooldown_until ?? null;
    entry.nextRetryAt = row.next_retry_at ?? null;
    entry.requestsLastRun = typeof row.requests_last_run === "number" ? row.requests_last_run : 0;
    entry.pagesLastRun = typeof row.pages_last_run === "number" ? row.pages_last_run : 0;
    entry.cardsLastRun = typeof row.cards_last_run === "number" ? row.cards_last_run : 0;
    if (row.provider_set_id) entryByProviderSetId.set(row.provider_set_id, entry);
    if (setId && !entryBySetId.has(setId)) entryBySetId.set(setId, entry);
  }

  for (const row of variantPriceRows) {
    const setId = String(row.set_id ?? "").trim() || buildSetId(row.set_name ?? "");
    if (!setId) continue;
    const existing = entryBySetId.get(setId);
    const entry = existing ?? ensureEntry(entryByKey, `setid:${setId}`, {
      setId,
      setName: row.set_name ?? setId,
    });
    if (!entry) continue;
    if (!entryBySetId.has(setId)) entryBySetId.set(setId, entry);
    if (row.canonical_slug) entry.pricedCanonicalSlugSet.add(row.canonical_slug);
    entry.pricedVariantRows += 1;
    entry.observationCount30dSum += typeof row.observation_count_30d === "number" ? row.observation_count_30d : 0;
    const observedAt = String(row.latest_observed_at ?? "");
    if (observedAt && observedAt >= freshCutoffIso) {
      if (row.canonical_slug) entry.freshCanonicalSlugSet.add(row.canonical_slug);
      entry.freshVariantRows24h += 1;
    }
  }

  for (const row of matchRows) {
    const providerSetId = String(row.provider_set_id ?? "").trim();
    if (!providerSetId) continue;
    const entry = entryByProviderSetId.get(providerSetId);
    if (!entry) continue;
    if (row.match_status === "MATCHED") entry.matchedCount += 1;
    if (row.match_status === "UNMATCHED") entry.unmatchedCount += 1;
  }

  const rows = [];
  for (const entry of entryByKey.values()) {
    const totalCanonicalCards = entry.canonicalSlugSet.size;
    const pricedCanonicalCards = entry.pricedCanonicalSlugSet.size;
    const freshCanonicalCards24h = entry.freshCanonicalSlugSet.size;
    if (yearFrom != null && (entry.year == null || entry.year < yearFrom)) continue;
    if (yearTo != null && (entry.year == null || entry.year > yearTo)) continue;

    entry.totalCanonicalCards = totalCanonicalCards;
    entry.pricedCanonicalCards = pricedCanonicalCards;
    entry.freshCanonicalCards24h = freshCanonicalCards24h;
    entry.coveragePct = calcPct(pricedCanonicalCards, totalCanonicalCards);
    entry.freshCoveragePct = calcPct(freshCanonicalCards24h, totalCanonicalCards);
    entry.matchRatePct = calcPct(entry.matchedCount, entry.matchedCount + entry.unmatchedCount);
    entry.requestsPerPricedCard = pricedCanonicalCards > 0 && entry.requestsLastRun > 0
      ? round(entry.requestsLastRun / pricedCanonicalCards, 2)
      : null;
    entry.requestsPerFreshCard = freshCanonicalCards24h > 0 && entry.requestsLastRun > 0
      ? round(entry.requestsLastRun / freshCanonicalCards24h, 2)
      : null;
    entry.freshCardsPerRequest = entry.requestsLastRun > 0
      ? round(freshCanonicalCards24h / entry.requestsLastRun, 2)
      : null;
    entry.cardsPerRequest = entry.requestsLastRun > 0
      ? round(entry.cardsLastRun / entry.requestsLastRun, 2)
      : null;
    entry.hoursSinceSuccess = hoursSince(entry.lastSuccessAt);
    entry.hoursSinceAttempt = hoursSince(entry.lastAttemptAt);
    entry.recommendation = classifyEntry(entry, nowMs);
    entry.priorityScore = scoreEntry(entry);
    entry.nextBatchRequests = nextBatchRequests(entry);
    rows.push(entry);
  }

  const sortedRows = sortEntries(rows);
  const topRows = sortedRows.slice(0, top);
  const immediateRequests = sortedRows.reduce((sum, row) => sum + row.nextBatchRequests, 0);
  const holdSetCount = sortedRows.filter((row) =>
    row.recommendation.startsWith("HOLD") || row.recommendation === "WAIT_COOLDOWN"
  ).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    budgetRequests,
    immediateRequests,
    reserveRequests: Math.max(0, budgetRequests - immediateRequests),
    setCount: sortedRows.length,
    provenPricedSetCount: sortedRows.filter((row) => row.pricedCanonicalCards > 0).length,
    holdSetCount,
  };

  if (format === "json") {
    const payload = {
      summary,
      rows: sortedRows.map((row) => ({
        provider: provider,
        setCode: row.setCode,
        setName: row.setName,
        setId: row.setId,
        providerSetId: row.providerSetId,
        year: row.year,
        mapConfidence: row.mapConfidence,
        totalCanonicalCards: row.totalCanonicalCards,
        totalPrintings: row.totalPrintings,
        pricedCanonicalCards: row.pricedCanonicalCards,
        freshCanonicalCards24h: row.freshCanonicalCards24h,
        coveragePct: row.coveragePct,
        freshCoveragePct: row.freshCoveragePct,
        matchedCount: row.matchedCount,
        unmatchedCount: row.unmatchedCount,
        matchRatePct: row.matchRatePct,
        requestsLastRun: row.requestsLastRun,
        pagesLastRun: row.pagesLastRun,
        cardsLastRun: row.cardsLastRun,
        cardsPerRequest: row.cardsPerRequest,
        freshCardsPerRequest: row.freshCardsPerRequest,
        requestsPerPricedCard: row.requestsPerPricedCard,
        requestsPerFreshCard: row.requestsPerFreshCard,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        lastStatusCode: row.lastStatusCode,
        lastError: row.lastError,
        recommendation: row.recommendation,
        nextBatchRequests: row.nextBatchRequests,
        priorityScore: row.priorityScore,
      })),
    };
    const json = JSON.stringify(payload, null, 2);
    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), json);
      console.log(`Wrote JSON report to ${path.resolve(outPath)}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
    return;
  }

  const markdown = rowsToMarkdown(topRows, summary, { provider });
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), markdown);
    console.log(`Wrote markdown report to ${path.resolve(outPath)}`);
  } else {
    process.stdout.write(markdown);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
