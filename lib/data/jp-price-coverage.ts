import type { SupabaseClient } from "@supabase/supabase-js";

export type JpPriceCoverageSource = "market" | "yahoo_jp" | "snkrdunk";

type JpPriceCoverageRow = {
  canonical_slug: string;
  display_price_source: string | null;
  display_price_usd: number | null;
  display_price_jpy: number | null;
  display_price_as_of: string | null;
  display_price_sample_count: number | null;
  market_price: number | null;
  market_price_as_of: string | null;
  market_confidence_score: number | null;
  market_low_confidence: boolean | null;
  active_listings_7d: number | null;
  snapshot_count_30d: number | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
  yahoo_jp_price: number | null;
  yahoo_jp_price_jpy: number | null;
  yahoo_jp_sample_count: number | null;
  yahoo_jp_observed_at: string | null;
  snkrdunk_price: number | null;
  snkrdunk_price_jpy: number | null;
  snkrdunk_sample_count: number | null;
  snkrdunk_observed_at: string | null;
};

export type JpPriceCoverage = {
  canonicalSlug: string;
  displayPriceSource: JpPriceCoverageSource;
  displayPriceUsd: number;
  displayPriceJpy: number | null;
  displayPriceAsOf: string | null;
  displayPriceSampleCount: number | null;
  marketPrice: number | null;
  marketPriceAsOf: string | null;
  marketConfidenceScore: number | null;
  marketLowConfidence: boolean | null;
  activeListings7d: number | null;
  snapshotCount30d: number | null;
  changePct24h: number | null;
  changePct7d: number | null;
  yahooJpPriceUsd: number | null;
  yahooJpPriceJpy: number | null;
  yahooJpSampleCount: number | null;
  yahooJpObservedAt: string | null;
  snkrdunkPriceUsd: number | null;
  snkrdunkPriceJpy: number | null;
  snkrdunkSampleCount: number | null;
  snkrdunkObservedAt: string | null;
};

const JP_COVERAGE_SELECT = [
  "canonical_slug",
  "display_price_source",
  "display_price_usd",
  "display_price_jpy",
  "display_price_as_of",
  "display_price_sample_count",
  "market_price",
  "market_price_as_of",
  "market_confidence_score",
  "market_low_confidence",
  "active_listings_7d",
  "snapshot_count_30d",
  "change_pct_24h",
  "change_pct_7d",
  "yahoo_jp_price",
  "yahoo_jp_price_jpy",
  "yahoo_jp_sample_count",
  "yahoo_jp_observed_at",
  "snkrdunk_price",
  "snkrdunk_price_jpy",
  "snkrdunk_sample_count",
  "snkrdunk_observed_at",
].join(", ");

const JP_COVERAGE_CHUNK_SIZE = 100;

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDisplaySource(value: string | null | undefined): JpPriceCoverageSource | null {
  if (value === "market" || value === "yahoo_jp" || value === "snkrdunk") return value;
  return null;
}

function normalizeJpCoverageRow(row: JpPriceCoverageRow): JpPriceCoverage | null {
  const source = normalizeDisplaySource(row.display_price_source);
  const displayPriceUsd = toFiniteNumber(row.display_price_usd);
  if (!source || displayPriceUsd === null || displayPriceUsd <= 0) return null;

  return {
    canonicalSlug: row.canonical_slug,
    displayPriceSource: source,
    displayPriceUsd,
    displayPriceJpy: toFiniteNumber(row.display_price_jpy),
    displayPriceAsOf: row.display_price_as_of ?? null,
    displayPriceSampleCount: toFiniteNumber(row.display_price_sample_count),
    marketPrice: toFiniteNumber(row.market_price),
    marketPriceAsOf: row.market_price_as_of ?? null,
    marketConfidenceScore: toFiniteNumber(row.market_confidence_score),
    marketLowConfidence: typeof row.market_low_confidence === "boolean" ? row.market_low_confidence : null,
    activeListings7d: toFiniteNumber(row.active_listings_7d),
    snapshotCount30d: toFiniteNumber(row.snapshot_count_30d),
    changePct24h: toFiniteNumber(row.change_pct_24h),
    changePct7d: toFiniteNumber(row.change_pct_7d),
    yahooJpPriceUsd: toFiniteNumber(row.yahoo_jp_price),
    yahooJpPriceJpy: toFiniteNumber(row.yahoo_jp_price_jpy),
    yahooJpSampleCount: toFiniteNumber(row.yahoo_jp_sample_count),
    yahooJpObservedAt: row.yahoo_jp_observed_at ?? null,
    snkrdunkPriceUsd: toFiniteNumber(row.snkrdunk_price),
    snkrdunkPriceJpy: toFiniteNumber(row.snkrdunk_price_jpy),
    snkrdunkSampleCount: toFiniteNumber(row.snkrdunk_sample_count),
    snkrdunkObservedAt: row.snkrdunk_observed_at ?? null,
  };
}

export async function loadJpPriceCoverageMap(
  supabase: SupabaseClient,
  slugs: string[],
): Promise<Map<string, JpPriceCoverage>> {
  const uniqueSlugs = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))];
  const coverageBySlug = new Map<string, JpPriceCoverage>();
  if (uniqueSlugs.length === 0) return coverageBySlug;

  for (let index = 0; index < uniqueSlugs.length; index += JP_COVERAGE_CHUNK_SIZE) {
    const chunk = uniqueSlugs.slice(index, index + JP_COVERAGE_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("public_jp_price_coverage")
      .select(JP_COVERAGE_SELECT)
      .in("canonical_slug", chunk)
      .eq("covered_by_price", true)
      .returns<JpPriceCoverageRow[]>();

    if (error) throw new Error(`public_jp_price_coverage: ${error.message}`);

    for (const row of data ?? []) {
      const normalized = normalizeJpCoverageRow(row);
      if (normalized) coverageBySlug.set(normalized.canonicalSlug, normalized);
    }
  }

  return coverageBySlug;
}

export function computeJpNativeConfidence(sampleCount: number | null | undefined): number {
  const samples = Math.max(0, Math.floor(toFiniteNumber(sampleCount) ?? 0));
  return Math.min(92, 60 + samples * 2);
}

export function isJpNativeCoverageSource(source: JpPriceCoverageSource | null | undefined): boolean {
  return source === "yahoo_jp" || source === "snkrdunk";
}
