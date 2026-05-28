#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  normalizePriceChartingProductRecord,
  parsePriceChartingCsv,
} from "../lib/backfill/pricecharting-normalize.ts";
import {
  buildPriceChartingMatchDecision,
  extractPriceChartingCardNumber,
  isPriceChartingCanonicalHeadlineProduct,
  isPriceChartingEnglishSingleCardProduct,
  normalizePriceChartingCardNumber,
} from "../lib/backfill/pricecharting-match.ts";

dotenv.config({ path: ".env.local", quiet: true });

const UPSERT_BATCH_SIZE = positiveIntegerEnv("PRICECHARTING_UPSERT_BATCH_SIZE", 500);
const MATCH_BATCH_SIZE = positiveIntegerEnv("PRICECHARTING_MATCH_BATCH_SIZE", 500);
const WRITE_RETRY_ATTEMPTS = positiveIntegerEnv("PRICECHARTING_WRITE_RETRY_ATTEMPTS", 4);
const PROVIDER = "PRICECHARTING";

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

function isRetryableWriteError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("fetch failed")
    || message.includes("network")
    || message.includes("timeout")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("socket");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSupabaseRetry(label, fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const result = await fn();
      if (result?.error) throw result.error;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= WRITE_RETRY_ATTEMPTS || !isRetryableWriteError(error)) break;
      const delayMs = 500 * attempt * attempt;
      console.warn(`${label}: retrying after ${String(error?.message ?? error)} (attempt ${attempt + 1}/${WRITE_RETRY_ATTEMPTS})`);
      await sleep(delayMs);
    }
  }
  throw new Error(`${label}: ${String(lastError?.message ?? lastError ?? "unknown error")}`);
}

function observedDateFromIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid --observed-at value: ${value}`);
  return date.toISOString().slice(0, 10);
}

async function readCsvText() {
  const csvFile = argValue("csv-file");
  const csvUrl = argValue("csv-url");
  if (csvFile && csvUrl) throw new Error("Pass only one of --csv-file or --csv-url");

  if (csvFile) {
    return fs.readFile(path.resolve(csvFile), "utf8");
  }

  if (!csvUrl) return null;
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`PriceCharting CSV fetch failed: HTTP ${res.status}`);
  return res.text();
}

async function readApiJsonRecords() {
  const jsonFile = argValue("json-file");
  const apiProductId = argValue("api-product-id");
  const apiQuery = argValue("api-query");
  const selected = [jsonFile, apiProductId, apiQuery].filter(Boolean);
  if (selected.length > 1) {
    throw new Error("Pass only one of --json-file, --api-product-id, or --api-query");
  }

  if (jsonFile) {
    const raw = await fs.readFile(path.resolve(jsonFile), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  }

  if (!apiProductId && !apiQuery) return null;
  const token = requireEnv("PRICECHARTING_TOKEN");
  const url = new URL("https://www.pricecharting.com/api/product");
  url.searchParams.set("t", token);
  if (apiProductId) url.searchParams.set("id", apiProductId);
  if (apiQuery) url.searchParams.set("q", apiQuery);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`PriceCharting API fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.status && body.status !== "success") {
    throw new Error(`PriceCharting API returned status=${body.status}`);
  }
  return [body];
}

async function loadPriceChartingRecords() {
  const csvText = await readCsvText();
  const apiRecords = await readApiJsonRecords();
  if (csvText && apiRecords) {
    throw new Error("Pass either a CSV input or an API JSON input, not both");
  }
  if (csvText) {
    return {
      importSource: "csv",
      records: parsePriceChartingCsv(csvText),
    };
  }
  if (apiRecords) {
    return {
      importSource: "api",
      records: apiRecords,
    };
  }
  throw new Error("Pass --csv-file, --csv-url, --json-file, --api-product-id, or --api-query");
}

function toProviderCardMapRows(matchRows, nowIso) {
  return matchRows.map((row) => ({
    provider: PROVIDER,
    provider_key: row.product_id,
    asset_type: row.asset_type,
    provider_set_id: null,
    provider_card_id: row.product_id,
    provider_variant_id: row.product_id,
    canonical_slug: row.match_status === "MATCHED" ? row.canonical_slug : null,
    printing_id: row.match_status === "MATCHED" ? row.printing_id : null,
    mapping_status: row.match_status === "MATCHED" ? "MATCHED" : "UNMATCHED",
    match_type: row.match_type,
    match_confidence: row.match_confidence == null ? null : row.match_confidence / 100,
    match_reason: row.match_reason,
    mapping_source: "PIPELINE",
    metadata: {
      ...(row.identity ?? {}),
      sourceTable: "pricecharting_product_matches",
      pricechartingMatchStatus: row.match_status,
    },
    last_seen_at: nowIso,
    last_observed_at: nowIso,
    last_matched_at: row.match_status === "MATCHED" ? nowIso : null,
    updated_at: nowIso,
  }));
}

async function loadCardsForMatch(supabase) {
  const cards = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await withSupabaseRetry("canonical_cards(load)", () =>
      supabase
        .from("canonical_cards")
        .select("slug, canonical_name, set_name, card_number, language")
        .eq("language", "EN")
        .range(from, from + 999)
    );
    const batch = data ?? [];
    cards.push(...batch);
    if (batch.length < 1000) break;
  }
  return cards;
}

function groupCardsByNormalizedNumber(cards) {
  const grouped = new Map();
  for (const card of cards) {
    if (String(card.language ?? "").trim().toUpperCase() !== "EN") continue;
    const normalizedNumber = normalizePriceChartingCardNumber(card.card_number);
    if (!normalizedNumber) continue;
    const existing = grouped.get(normalizedNumber) ?? [];
    existing.push(card);
    grouped.set(normalizedNumber, existing);
  }
  return grouped;
}

function candidateCardsForProduct(cardsByNumber, product) {
  const productNumber = extractPriceChartingCardNumber(String(product.product_name ?? ""));
  if (!productNumber) return [];
  return cardsByNumber.get(productNumber) ?? [];
}

async function loadPrintingsForSlugs(supabase, slugs) {
  const uniqueSlugs = [...new Set(slugs.filter(Boolean))];
  if (uniqueSlugs.length === 0) return [];

  const rows = [];
  for (const chunk of chunkRows(uniqueSlugs, 500)) {
    const { data } = await withSupabaseRetry("card_printings(load)", () =>
      supabase
        .from("card_printings")
        .select("id, canonical_slug, language, finish, edition, stamp")
        .in("canonical_slug", chunk)
        .eq("language", "EN")
    );
    rows.push(...(data ?? []));
  }
  return rows;
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const shouldMatch = hasFlag("match");
  const shouldRefreshParity = hasFlag("refresh-parity");
  const shouldSkipProductUpsert = hasFlag("skip-products") || hasFlag("skip-product-upsert");
  const shouldSkipObservationUpsert = hasFlag("skip-observations") || hasFlag("skip-observation-upsert");
  const shouldSkipPrintingResolution = hasFlag("skip-printings") || hasFlag("skip-printing-resolution");
  const observedAt = argValue("observed-at", new Date().toISOString());
  const observedOn = observedDateFromIso(observedAt);
  const { importSource, records } = await loadPriceChartingRecords();
  const normalized = records.map((record) => normalizePriceChartingProductRecord({
    record,
    observedAt,
    importSource,
    pokemonOnly: true,
  }));
  const products = normalized
    .filter((result) => result.ok)
    .map((result) => result.row);
  const observations = products
    .filter((product) => typeof product.loose_price_usd === "number" && product.loose_price_usd > 0)
    .map((product) => ({
      product_id: product.product_id,
      observed_on: observedOn,
      observed_at: observedAt,
      loose_price_usd: product.loose_price_usd,
      sales_volume: product.sales_volume,
      import_source: importSource,
      raw_payload: product.raw_payload,
    }));
  const matchableProducts = products.filter((product) =>
    isPriceChartingEnglishSingleCardProduct(product)
  );
  const skipped = new Map();
  for (const result of normalized) {
    if (result.ok) continue;
    skipped.set(result.reason, (skipped.get(result.reason) ?? 0) + 1);
  }

  const summary = {
    ok: true,
    observedAt,
    importSource,
    dryRun,
    productUpsertSkipped: shouldSkipProductUpsert,
    observationUpsertSkipped: shouldSkipObservationUpsert,
    printingResolutionSkipped: shouldSkipPrintingResolution,
    recordsParsed: records.length,
    productsReady: products.length,
    observationsReady: observations.length,
    skipped: Object.fromEntries(skipped),
    productsUpserted: 0,
    observationsUpserted: 0,
    productsEligibleForAutoMatch: matchableProducts.length,
    matchesUpserted: 0,
    providerCardMapRowsUpserted: 0,
    parityRowsRefreshed: null,
    trustedRowsRefreshed: null,
    sampleProducts: products.slice(0, 5).map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      console_name: row.console_name,
      tcg_id: row.tcg_id,
      loose_price_usd: row.loose_price_usd,
    })),
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  if (!shouldSkipProductUpsert) {
    for (const chunk of chunkRows(products, UPSERT_BATCH_SIZE)) {
      await withSupabaseRetry("pricecharting_products(upsert)", () =>
        supabase
          .from("pricecharting_products")
          .upsert(chunk, { onConflict: "product_id" })
      );
      summary.productsUpserted += chunk.length;
    }
  }

  if (!shouldSkipObservationUpsert) {
    for (const chunk of chunkRows(observations, UPSERT_BATCH_SIZE)) {
      await withSupabaseRetry("pricecharting_product_observations(upsert)", () =>
        supabase
          .from("pricecharting_product_observations")
          .upsert(chunk, { onConflict: "product_id,observed_on" })
      );
      summary.observationsUpserted += chunk.length;
    }
  }

  if (shouldMatch && products.length > 0) {
    const cards = await loadCardsForMatch(supabase);
    const cardsByNumber = groupCardsByNormalizedNumber(cards);
    const preliminaryMatches = matchableProducts.map((product) => buildPriceChartingMatchDecision({
      product: product,
      canonicalCards: candidateCardsForProduct(cardsByNumber, product),
      printings: [],
    }));
    const printings = shouldSkipPrintingResolution
      ? []
      : await loadPrintingsForSlugs(
        supabase,
        preliminaryMatches.map((row) => row.canonicalSlug),
      );
    const matchRows = matchableProducts.map((product) => {
      const decision = buildPriceChartingMatchDecision({
        product,
        canonicalCards: candidateCardsForProduct(cardsByNumber, product),
        printings,
      });
      return {
        product_id: decision.productId,
        canonical_slug: decision.canonicalSlug,
        printing_id: decision.printingId,
        asset_type: "single",
        match_status: decision.matchStatus,
        match_type: decision.matchType,
        match_confidence: decision.matchConfidence,
        match_reason: decision.matchReason,
        mapping_source: "AUTO",
        identity: {
          ...decision.identity,
          pricechartingHeadlineEligible: decision.matchStatus === "MATCHED"
            && isPriceChartingCanonicalHeadlineProduct(product),
          pricechartingPrintingEligible: decision.matchStatus === "MATCHED"
            && decision.printingId !== null,
        },
      };
    });

    for (const chunk of chunkRows(matchRows, MATCH_BATCH_SIZE)) {
      await withSupabaseRetry("pricecharting_product_matches(upsert)", () =>
        supabase
          .from("pricecharting_product_matches")
          .upsert(chunk, { onConflict: "product_id,canonical_slug,printing_id" })
      );
      summary.matchesUpserted += chunk.length;
    }

    const providerCardMapRows = toProviderCardMapRows(matchRows, observedAt);
    for (const chunk of chunkRows(providerCardMapRows, MATCH_BATCH_SIZE)) {
      await withSupabaseRetry("provider_card_map(PRICECHARTING upsert)", () =>
        supabase
          .from("provider_card_map")
          .upsert(chunk, { onConflict: "provider,provider_key" })
      );
      summary.providerCardMapRowsUpserted += chunk.length;
    }
  }

  if (shouldRefreshParity) {
    const { data: trustedRows } = await withSupabaseRetry("refresh_canonical_trusted_raw_prices", () =>
      supabase.rpc("refresh_canonical_trusted_raw_prices", {
        p_window_days: 7,
        p_agreement_pct: 35,
      })
    );
    summary.trustedRowsRefreshed = trustedRows ?? 0;
    summary.parityRowsRefreshed = 0;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
