// Shared PriceCharting ingestion pipeline.
//
// One code path, two callers:
//   - scripts/import-pricecharting-products.mjs (manual/operator CLI)
//   - app/api/cron/import-pricecharting/route.ts (scheduled Vercel cron)
//
// Keeping the orchestration here (rather than duplicated in the CLI and
// the route) means the daily cron runs EXACTLY the matching/normalization
// logic an operator would run by hand — no drift between "what I tested
// locally" and "what production does at 6am".
//
// The function is deliberately I/O-agnostic about its INPUT: it takes
// already-parsed records + an existing Supabase client. CSV fetching and
// client construction are the caller's job. That keeps this module free of
// `server-only` and env coupling, so the CLI (service-role key from
// .env.local) and the route (service-role key from Vercel) can both drive
// it.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizePriceChartingProductRecord,
  parsePriceChartingCsv,
  type PriceChartingImportSource,
  type PriceChartingProductUpsertRow,
  type PriceChartingRawRecord,
  type PriceChartingSkipReason,
} from "./pricecharting-normalize";
import {
  buildPriceChartingMatchDecision,
  extractPriceChartingCardNumber,
  isPriceChartingCanonicalHeadlineProduct,
  isPriceChartingEnglishSingleCardProduct,
  normalizePriceChartingCardNumber,
} from "./pricecharting-match";

const PROVIDER = "PRICECHARTING";

export const DEFAULT_UPSERT_BATCH_SIZE = 500;
export const DEFAULT_MATCH_BATCH_SIZE = 500;
export const DEFAULT_WRITE_RETRY_ATTEMPTS = 4;
export const DEFAULT_PARITY_WINDOW_DAYS = 7;
export const DEFAULT_PARITY_AGREEMENT_PCT = 35;

export type PriceChartingIngestOptions = {
  /** Required unless `dryRun` is true. */
  supabase: SupabaseClient | null;
  records: Record<string, unknown>[];
  importSource: PriceChartingImportSource;
  /** ISO timestamp stamped on every product/observation row. Defaults to now. */
  observedAt?: string;
  dryRun?: boolean;
  /** Run canonical/printing matching (expensive — scans the full EN catalog). */
  match?: boolean;
  /** Run the trusted-raw-price parity RPC after writes. Defaults to true. */
  refreshParity?: boolean;
  skipProductUpsert?: boolean;
  skipObservationUpsert?: boolean;
  skipPrintingResolution?: boolean;
  upsertBatchSize?: number;
  matchBatchSize?: number;
  writeRetryAttempts?: number;
  parityWindowDays?: number;
  parityAgreementPct?: number;
};

export type PriceChartingIngestSummary = {
  ok: boolean;
  observedAt: string;
  importSource: PriceChartingImportSource;
  dryRun: boolean;
  matched: boolean;
  parityRefreshed: boolean;
  productUpsertSkipped: boolean;
  observationUpsertSkipped: boolean;
  printingResolutionSkipped: boolean;
  recordsParsed: number;
  productsReady: number;
  observationsReady: number;
  skipped: Record<string, number>;
  productsUpserted: number;
  observationsUpserted: number;
  productsEligibleForAutoMatch: number;
  matchesUpserted: number;
  providerCardMapRowsUpserted: number;
  parityRowsRefreshed: number | null;
  trustedRowsRefreshed: number | null;
  sampleProducts: Array<{
    product_id: string;
    product_name: string;
    console_name: string | null;
    tcg_id: string | null;
    loose_price_usd: number | null;
  }>;
};

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  language: string | null;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  language: string;
  finish: string;
  edition: string;
  stamp: string | null;
};

type MatchRow = {
  product_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  asset_type: string;
  match_status: string;
  match_type: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  mapping_source: string;
  identity: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// CSV input helper (route + CLI share the throw-on-failure contract)
// ---------------------------------------------------------------------------

/**
 * Fetch + parse the PriceCharting CSV. Throws on a non-OK response so a
 * dead/expired download URL surfaces as a failed cron run rather than a
 * silent no-op that quietly writes zero rows (the silent-fallback
 * anti-pattern this codebase has been burned by before).
 */
export async function fetchPriceChartingCsvRecords(
  url: string,
): Promise<PriceChartingRawRecord[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`PriceCharting CSV fetch failed: HTTP ${res.status}`);
  }
  return parsePriceChartingCsv(await res.text());
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

function isRetryableWriteError(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? "",
  ).toLowerCase();
  return message.includes("fetch failed")
    || message.includes("network")
    || message.includes("timeout")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("socket");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSupabaseRetry<T extends { data?: unknown; error?: unknown }>(
  label: string,
  attempts: number,
  fn: () => PromiseLike<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn();
      if (result?.error) throw result.error;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableWriteError(error)) break;
      const delayMs = 500 * attempt * attempt;
      console.warn(
        `${label}: retrying after ${String((error as { message?: unknown })?.message ?? error)} (attempt ${attempt + 1}/${attempts})`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error(
    `${label}: ${String((lastError as { message?: unknown })?.message ?? lastError ?? "unknown error")}`,
  );
}

function observedDateFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid observedAt value: ${value}`);
  return date.toISOString().slice(0, 10);
}

function toProviderCardMapRows(matchRows: MatchRow[], nowIso: string) {
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

async function loadCardsForMatch(
  supabase: SupabaseClient,
  attempts: number,
): Promise<CanonicalCardRow[]> {
  const cards: CanonicalCardRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await withSupabaseRetry("canonical_cards(load)", attempts, () =>
      supabase
        .from("canonical_cards")
        .select("slug, canonical_name, set_name, card_number, language")
        .eq("language", "EN")
        .range(from, from + 999),
    );
    const batch = (data ?? []) as CanonicalCardRow[];
    cards.push(...batch);
    if (batch.length < 1000) break;
  }
  return cards;
}

function groupCardsByNormalizedNumber(
  cards: CanonicalCardRow[],
): Map<string, CanonicalCardRow[]> {
  const grouped = new Map<string, CanonicalCardRow[]>();
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

function candidateCardsForProduct(
  cardsByNumber: Map<string, CanonicalCardRow[]>,
  product: PriceChartingProductUpsertRow,
): CanonicalCardRow[] {
  const productNumber = extractPriceChartingCardNumber(String(product.product_name ?? ""));
  if (!productNumber) return [];
  return cardsByNumber.get(productNumber) ?? [];
}

async function loadPrintingsForSlugs(
  supabase: SupabaseClient,
  attempts: number,
  slugs: Array<string | null>,
): Promise<PrintingRow[]> {
  const uniqueSlugs = [...new Set(slugs.filter((slug): slug is string => Boolean(slug)))];
  if (uniqueSlugs.length === 0) return [];

  const rows: PrintingRow[] = [];
  for (const chunk of chunkRows(uniqueSlugs, 500)) {
    const { data } = await withSupabaseRetry("card_printings(load)", attempts, () =>
      supabase
        .from("card_printings")
        .select("id, canonical_slug, language, finish, edition, stamp")
        .in("canonical_slug", chunk)
        .eq("language", "EN"),
    );
    rows.push(...((data ?? []) as PrintingRow[]));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runPriceChartingIngest(
  options: PriceChartingIngestOptions,
): Promise<PriceChartingIngestSummary> {
  const dryRun = options.dryRun ?? false;
  const shouldMatch = options.match ?? false;
  const shouldRefreshParity = options.refreshParity ?? true;
  const skipProductUpsert = options.skipProductUpsert ?? false;
  const skipObservationUpsert = options.skipObservationUpsert ?? false;
  const skipPrintingResolution = options.skipPrintingResolution ?? false;
  const upsertBatchSize = options.upsertBatchSize ?? DEFAULT_UPSERT_BATCH_SIZE;
  const matchBatchSize = options.matchBatchSize ?? DEFAULT_MATCH_BATCH_SIZE;
  const writeRetryAttempts = options.writeRetryAttempts ?? DEFAULT_WRITE_RETRY_ATTEMPTS;
  const parityWindowDays = options.parityWindowDays ?? DEFAULT_PARITY_WINDOW_DAYS;
  const parityAgreementPct = options.parityAgreementPct ?? DEFAULT_PARITY_AGREEMENT_PCT;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const observedOn = observedDateFromIso(observedAt);
  const importSource = options.importSource;

  const normalized = options.records.map((record) =>
    normalizePriceChartingProductRecord({
      record,
      observedAt,
      importSource,
      pokemonOnly: true,
    }),
  );
  const products = normalized
    .filter((result): result is { ok: true; row: PriceChartingProductUpsertRow } => result.ok)
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
    isPriceChartingEnglishSingleCardProduct(product),
  );
  const skipped = new Map<PriceChartingSkipReason, number>();
  for (const result of normalized) {
    if (result.ok) continue;
    skipped.set(result.reason, (skipped.get(result.reason) ?? 0) + 1);
  }

  const summary: PriceChartingIngestSummary = {
    ok: true,
    observedAt,
    importSource,
    dryRun,
    matched: shouldMatch,
    parityRefreshed: shouldRefreshParity,
    productUpsertSkipped: skipProductUpsert,
    observationUpsertSkipped: skipObservationUpsert,
    printingResolutionSkipped: skipPrintingResolution,
    recordsParsed: options.records.length,
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

  if (dryRun) return summary;

  const supabase = options.supabase;
  if (!supabase) {
    throw new Error("runPriceChartingIngest requires a Supabase client unless dryRun is true");
  }

  if (!skipProductUpsert) {
    for (const chunk of chunkRows(products, upsertBatchSize)) {
      await withSupabaseRetry("pricecharting_products(upsert)", writeRetryAttempts, () =>
        supabase.from("pricecharting_products").upsert(chunk, { onConflict: "product_id" }),
      );
      summary.productsUpserted += chunk.length;
    }
  }

  if (!skipObservationUpsert) {
    for (const chunk of chunkRows(observations, upsertBatchSize)) {
      await withSupabaseRetry("pricecharting_product_observations(upsert)", writeRetryAttempts, () =>
        supabase
          .from("pricecharting_product_observations")
          .upsert(chunk, { onConflict: "product_id,observed_on" }),
      );
      summary.observationsUpserted += chunk.length;
    }
  }

  if (shouldMatch && products.length > 0) {
    const cards = await loadCardsForMatch(supabase, writeRetryAttempts);
    const cardsByNumber = groupCardsByNormalizedNumber(cards);
    const preliminaryMatches = matchableProducts.map((product) =>
      buildPriceChartingMatchDecision({
        product,
        canonicalCards: candidateCardsForProduct(cardsByNumber, product),
        printings: [],
      }),
    );
    const printings = skipPrintingResolution
      ? []
      : await loadPrintingsForSlugs(
          supabase,
          writeRetryAttempts,
          preliminaryMatches.map((row) => row.canonicalSlug),
        );
    const matchRows: MatchRow[] = matchableProducts.map((product) => {
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
          pricechartingHeadlineEligible:
            decision.matchStatus === "MATCHED" && isPriceChartingCanonicalHeadlineProduct(product),
          pricechartingPrintingEligible:
            decision.matchStatus === "MATCHED" && decision.printingId !== null,
        },
      };
    });

    for (const chunk of chunkRows(matchRows, matchBatchSize)) {
      await withSupabaseRetry("pricecharting_product_matches(upsert)", writeRetryAttempts, () =>
        supabase
          .from("pricecharting_product_matches")
          .upsert(chunk, { onConflict: "product_id,canonical_slug,printing_id" }),
      );
      summary.matchesUpserted += chunk.length;
    }

    const providerCardMapRows = toProviderCardMapRows(matchRows, observedAt);
    for (const chunk of chunkRows(providerCardMapRows, matchBatchSize)) {
      await withSupabaseRetry("provider_card_map(PRICECHARTING upsert)", writeRetryAttempts, () =>
        supabase.from("provider_card_map").upsert(chunk, { onConflict: "provider,provider_key" }),
      );
      summary.providerCardMapRowsUpserted += chunk.length;
    }
  }

  if (shouldRefreshParity) {
    const { data: trustedRows } = await withSupabaseRetry(
      "refresh_canonical_trusted_raw_prices",
      writeRetryAttempts,
      () =>
        supabase.rpc("refresh_canonical_trusted_raw_prices", {
          p_window_days: parityWindowDays,
          p_agreement_pct: parityAgreementPct,
        }),
    );
    summary.trustedRowsRefreshed = (trustedRows as number | null) ?? 0;
    summary.parityRowsRefreshed = 0;
  }

  return summary;
}
