import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeJpNativeConfidence,
  isJpNativeCoverageSource,
  loadJpPriceCoverageMap,
  type JpPriceCoverage,
} from "@/lib/data/jp-price-coverage";
import { resolveCardImage } from "@/lib/images/resolve";

export type ArbitrageDirection = "JP_PREMIUM" | "EN_PREMIUM" | "PARITY";
export type ArbitrageAction = "BUY_EN_SELL_JP" | "BUY_JP_SELL_EN" | "WATCH";

export type ArbitragePairRow = {
  en_slug: string;
  jp_slug: string;
  confidence: number;
  source: string;
};

export type ArbitrageCardMeta = {
  slug: string;
  canonical_name: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
  primary_image_url?: string | null;
  mirrored_primary_image_url?: string | null;
  mirrored_primary_thumb_url?: string | null;
};

export type EnMarketMetric = {
  canonical_slug: string;
  market_price: number | null;
  market_price_as_of: string | null;
  market_confidence_score: number | null;
  market_low_confidence: boolean | null;
  active_listings_7d: number | null;
  snapshot_count_30d: number | null;
};

export type JpEnArbitrageOpportunity = {
  pair: {
    enSlug: string;
    jpSlug: string;
    confidence: number;
    source: string;
  };
  en: {
    slug: string;
    name: string;
    setName: string | null;
    year: number | null;
    cardNumber: string | null;
    imageUrl: string | null;
    priceUsd: number;
    priceAsOf: string | null;
    confidenceScore: number | null;
  };
  jp: {
    slug: string;
    name: string;
    setName: string | null;
    year: number | null;
    cardNumber: string | null;
    imageUrl: string | null;
    priceUsd: number;
    priceJpy: number | null;
    priceAsOf: string | null;
    source: "market" | "yahoo_jp" | "snkrdunk";
    sampleCount: number | null;
    confidenceScore: number | null;
  };
  spread: {
    jpPremiumPct: number;
    enPremiumPct: number;
    absolutePremiumPct: number;
    absoluteSpreadUsd: number;
    estimatedFrictionPct: number;
    netEdgePct: number;
  };
  direction: ArbitrageDirection;
  action: ArbitrageAction;
  confidence: {
    score: number;
    flags: string[];
  };
  headline: string;
};

export type JpEnArbitrageCoverage = {
  pairsScanned: number;
  comparablePairs: number;
  missingEnPrice: number;
  missingJpPrice: number;
  belowMinPrice: number;
  belowMinPremium: number;
};

export type JpEnArbitrageResult = {
  opportunities: JpEnArbitrageOpportunity[];
  coverage: JpEnArbitrageCoverage;
};

export type JpEnArbitrageOptions = {
  limit?: number;
  scanLimit?: number;
  minPairConfidence?: number;
  minPriceUsd?: number;
  minPremiumPct?: number;
  estimatedFrictionPct?: number;
  direction?: "any" | "jp-premium" | "en-premium";
  slug?: string | null;
  nowMs?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SCAN_LIMIT = 2000;
const MAX_SCAN_LIMIT = 5000;
const DEFAULT_MIN_PAIR_CONFIDENCE = 0.9;
const DEFAULT_MIN_PRICE_USD = 2;
const DEFAULT_MIN_PREMIUM_PCT = 8;
const DEFAULT_ESTIMATED_FRICTION_PCT = 12;
const STALE_PRICE_MS = 7 * 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 100;

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function stalePriceFlag(asOf: string | null, nowMs: number, label: "EN" | "JP"): string | null {
  if (!asOf) return `${label}_PRICE_UNDATED`;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return `${label}_PRICE_UNDATED`;
  return nowMs - asOfMs > STALE_PRICE_MS ? `${label}_PRICE_STALE` : null;
}

function sourceLabel(source: JpPriceCoverage["displayPriceSource"]): string {
  if (source === "snkrdunk") return "Snkrdunk";
  if (source === "yahoo_jp") return "Yahoo! JP";
  return "market";
}

function imageForCard(card: ArbitrageCardMeta): string | null {
  return resolveCardImage(card).thumb ?? resolveCardImage(card).full;
}

function cardName(card: ArbitrageCardMeta | null, fallbackSlug: string): string {
  return card?.canonical_name?.trim() || fallbackSlug;
}

function computeConfidence(params: {
  pairConfidence: number;
  enMetric: EnMarketMetric;
  jpCoverage: JpPriceCoverage;
  nowMs: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  const pairScore = Math.round(params.pairConfidence * 100);
  const enScore = finiteNumber(params.enMetric.market_confidence_score)
    ?? ((finiteNumber(params.enMetric.snapshot_count_30d) ?? 0) >= 10 ? 75 : 60);
  const jpNative = isJpNativeCoverageSource(params.jpCoverage.displayPriceSource);
  const jpScore = jpNative
    ? computeJpNativeConfidence(params.jpCoverage.displayPriceSampleCount)
    : finiteNumber(params.jpCoverage.marketConfidenceScore) ?? 70;

  if (pairScore < 90) flags.push("PAIR_CONFIDENCE_BELOW_90");
  if (enScore < 70 || params.enMetric.market_low_confidence === true) flags.push("EN_PRICE_LOW_CONFIDENCE");
  if (jpScore < 70 || params.jpCoverage.marketLowConfidence === true) flags.push("JP_PRICE_LOW_CONFIDENCE");
  if (jpNative && (finiteNumber(params.jpCoverage.displayPriceSampleCount) ?? 0) < 5) {
    flags.push("JP_SAMPLE_UNDER_5");
  }

  const enStale = stalePriceFlag(params.enMetric.market_price_as_of, params.nowMs, "EN");
  const jpStale = stalePriceFlag(params.jpCoverage.displayPriceAsOf, params.nowMs, "JP");
  if (enStale) flags.push(enStale);
  if (jpStale) flags.push(jpStale);

  const stalePenalty = flags.filter((flag) => flag.endsWith("_STALE") || flag.endsWith("_UNDATED")).length * 8;
  const lowConfidencePenalty = flags.filter((flag) => flag.includes("LOW_CONFIDENCE")).length * 5;
  const score = Math.max(0, Math.min(pairScore, enScore, jpScore) - stalePenalty - lowConfidencePenalty);
  return { score: Math.round(score), flags };
}

function directionAllowed(
  direction: ArbitrageDirection,
  filter: JpEnArbitrageOptions["direction"],
): boolean {
  if (!filter || filter === "any") return true;
  if (filter === "jp-premium") return direction === "JP_PREMIUM";
  return direction === "EN_PREMIUM";
}

export function buildJpEnArbitrageOpportunity(params: {
  pair: ArbitragePairRow;
  enCard: ArbitrageCardMeta | null;
  jpCard: ArbitrageCardMeta | null;
  enMetric: EnMarketMetric | null;
  jpCoverage: JpPriceCoverage | null;
  estimatedFrictionPct?: number;
  nowMs?: number;
}): JpEnArbitrageOpportunity | null {
  const enPrice = finiteNumber(params.enMetric?.market_price);
  const jpPrice = finiteNumber(params.jpCoverage?.displayPriceUsd);
  if (!params.enMetric || !params.jpCoverage || enPrice === null || jpPrice === null || enPrice <= 0 || jpPrice <= 0) {
    return null;
  }

  const estimatedFrictionPct = clampNumber(
    params.estimatedFrictionPct,
    DEFAULT_ESTIMATED_FRICTION_PCT,
    0,
    50,
  );
  const nowMs = params.nowMs ?? Date.now();
  const jpPremiumPctRaw = ((jpPrice - enPrice) / enPrice) * 100;
  const jpPremiumPct = roundPct(jpPremiumPctRaw);
  const enPremiumPct = roundPct(((enPrice - jpPrice) / jpPrice) * 100);
  const absolutePremiumPct = roundPct(Math.abs(jpPremiumPctRaw));
  const absoluteSpreadUsd = roundMoney(Math.abs(jpPrice - enPrice));
  const netEdgePct = roundPct(absolutePremiumPct - estimatedFrictionPct);
  const direction: ArbitrageDirection = jpPremiumPctRaw > 0
    ? "JP_PREMIUM"
    : jpPremiumPctRaw < 0
      ? "EN_PREMIUM"
      : "PARITY";
  const action: ArbitrageAction = netEdgePct > 0 && direction === "JP_PREMIUM"
    ? "BUY_EN_SELL_JP"
    : netEdgePct > 0 && direction === "EN_PREMIUM"
      ? "BUY_JP_SELL_EN"
      : "WATCH";
  const confidence = computeConfidence({
    pairConfidence: params.pair.confidence,
    enMetric: params.enMetric,
    jpCoverage: params.jpCoverage,
    nowMs,
  });
  const enName = cardName(params.enCard, params.pair.en_slug);
  const jpName = cardName(params.jpCard, params.pair.jp_slug);
  const premiumText = `${absolutePremiumPct.toFixed(1)}%`;
  const headline = direction === "JP_PREMIUM"
    ? `JP buyers are paying a ${premiumText} premium for ${enName}.`
    : direction === "EN_PREMIUM"
      ? `EN buyers are paying a ${premiumText} premium over JP for ${enName}.`
      : `${enName} is near parity between EN and JP.`;

  return {
    pair: {
      enSlug: params.pair.en_slug,
      jpSlug: params.pair.jp_slug,
      confidence: params.pair.confidence,
      source: params.pair.source,
    },
    en: {
      slug: params.pair.en_slug,
      name: enName,
      setName: params.enCard?.set_name ?? null,
      year: params.enCard?.year ?? null,
      cardNumber: params.enCard?.card_number ?? null,
      imageUrl: params.enCard ? imageForCard(params.enCard) : null,
      priceUsd: roundMoney(enPrice),
      priceAsOf: params.enMetric.market_price_as_of ?? null,
      confidenceScore: finiteNumber(params.enMetric.market_confidence_score),
    },
    jp: {
      slug: params.pair.jp_slug,
      name: jpName,
      setName: params.jpCard?.set_name ?? null,
      year: params.jpCard?.year ?? null,
      cardNumber: params.jpCard?.card_number ?? null,
      imageUrl: params.jpCard ? imageForCard(params.jpCard) : null,
      priceUsd: roundMoney(jpPrice),
      priceJpy: params.jpCoverage.displayPriceJpy,
      priceAsOf: params.jpCoverage.displayPriceAsOf,
      source: params.jpCoverage.displayPriceSource,
      sampleCount: params.jpCoverage.displayPriceSampleCount,
      confidenceScore: isJpNativeCoverageSource(params.jpCoverage.displayPriceSource)
        ? computeJpNativeConfidence(params.jpCoverage.displayPriceSampleCount)
        : finiteNumber(params.jpCoverage.marketConfidenceScore),
    },
    spread: {
      jpPremiumPct,
      enPremiumPct,
      absolutePremiumPct,
      absoluteSpreadUsd,
      estimatedFrictionPct,
      netEdgePct,
    },
    direction,
    action,
    confidence,
    headline,
  };
}

async function loadPrimaryPairs(
  supabase: SupabaseClient,
  options: Required<Pick<JpEnArbitrageOptions, "scanLimit" | "minPairConfidence">> & { slug: string | null },
): Promise<ArbitragePairRow[]> {
  let query = supabase
    .from("card_translations")
    .select("en_slug, jp_slug, confidence, source")
    .eq("rank", 0)
    .gte("confidence", options.minPairConfidence)
    .order("confidence", { ascending: false })
    .limit(options.scanLimit);

  if (options.slug) {
    query = query.or(`en_slug.eq.${options.slug},jp_slug.eq.${options.slug}`);
  }

  const { data, error } = await query.returns<ArbitragePairRow[]>();
  if (error) throw new Error(`card_translations: ${error.message}`);
  return data ?? [];
}

async function loadEnMetricMap(
  supabase: SupabaseClient,
  slugs: string[],
): Promise<Map<string, EnMarketMetric>> {
  const uniqueSlugs = [...new Set(slugs.filter(Boolean))];
  const metricMap = new Map<string, EnMarketMetric>();
  for (let index = 0; index < uniqueSlugs.length; index += CHUNK_SIZE) {
    const chunk = uniqueSlugs.slice(index, index + CHUNK_SIZE);
    const { data, error } = await supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price, market_price_as_of, market_confidence_score, market_low_confidence, active_listings_7d, snapshot_count_30d")
      .in("canonical_slug", chunk)
      .is("printing_id", null)
      .eq("grade", "RAW")
      .returns<EnMarketMetric[]>();
    if (error) throw new Error(`public_card_metrics: ${error.message}`);
    for (const row of data ?? []) {
      if (!metricMap.has(row.canonical_slug)) metricMap.set(row.canonical_slug, row);
    }
  }
  return metricMap;
}

async function loadCardMetaMap(
  supabase: SupabaseClient,
  slugs: string[],
): Promise<Map<string, ArbitrageCardMeta>> {
  const uniqueSlugs = [...new Set(slugs.filter(Boolean))];
  const cardMap = new Map<string, ArbitrageCardMeta>();
  for (let index = 0; index < uniqueSlugs.length; index += CHUNK_SIZE) {
    const chunk = uniqueSlugs.slice(index, index + CHUNK_SIZE);
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number, language, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url")
      .in("slug", chunk)
      .returns<ArbitrageCardMeta[]>();
    if (error) throw new Error(`canonical_cards: ${error.message}`);
    for (const row of data ?? []) cardMap.set(row.slug, row);
  }
  return cardMap;
}

export async function getJpEnArbitrageOpportunities(
  supabase: SupabaseClient,
  options: JpEnArbitrageOptions = {},
): Promise<JpEnArbitrageResult> {
  const limit = Math.floor(clampNumber(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT));
  const scanLimit = Math.floor(clampNumber(options.scanLimit, DEFAULT_SCAN_LIMIT, 1, MAX_SCAN_LIMIT));
  const minPairConfidence = clampNumber(
    options.minPairConfidence,
    DEFAULT_MIN_PAIR_CONFIDENCE,
    0,
    1,
  );
  const minPriceUsd = clampNumber(options.minPriceUsd, DEFAULT_MIN_PRICE_USD, 0, 100000);
  const minPremiumPct = clampNumber(options.minPremiumPct, DEFAULT_MIN_PREMIUM_PCT, 0, 500);
  const estimatedFrictionPct = clampNumber(
    options.estimatedFrictionPct,
    DEFAULT_ESTIMATED_FRICTION_PCT,
    0,
    50,
  );
  const direction = options.direction ?? "any";
  const slug = options.slug?.trim() || null;
  const nowMs = options.nowMs ?? Date.now();

  const pairs = await loadPrimaryPairs(supabase, { scanLimit, minPairConfidence, slug });
  const enSlugs = pairs.map((pair) => pair.en_slug);
  const jpSlugs = pairs.map((pair) => pair.jp_slug);

  const [enMetrics, jpCoverage, cardMeta] = await Promise.all([
    loadEnMetricMap(supabase, enSlugs),
    loadJpPriceCoverageMap(supabase, jpSlugs),
    loadCardMetaMap(supabase, [...enSlugs, ...jpSlugs]),
  ]);

  const coverage: JpEnArbitrageCoverage = {
    pairsScanned: pairs.length,
    comparablePairs: 0,
    missingEnPrice: 0,
    missingJpPrice: 0,
    belowMinPrice: 0,
    belowMinPremium: 0,
  };
  const opportunities: JpEnArbitrageOpportunity[] = [];

  for (const pair of pairs) {
    const enMetric = enMetrics.get(pair.en_slug) ?? null;
    const jpPrice = jpCoverage.get(pair.jp_slug) ?? null;
    if (!enMetric || finiteNumber(enMetric.market_price) === null) {
      coverage.missingEnPrice += 1;
      continue;
    }
    if (!jpPrice) {
      coverage.missingJpPrice += 1;
      continue;
    }

    const enValue = finiteNumber(enMetric.market_price) ?? 0;
    if (enValue < minPriceUsd || jpPrice.displayPriceUsd < minPriceUsd) {
      coverage.belowMinPrice += 1;
      continue;
    }

    const opportunity = buildJpEnArbitrageOpportunity({
      pair,
      enCard: cardMeta.get(pair.en_slug) ?? null,
      jpCard: cardMeta.get(pair.jp_slug) ?? null,
      enMetric,
      jpCoverage: jpPrice,
      estimatedFrictionPct,
      nowMs,
    });
    if (!opportunity) continue;
    coverage.comparablePairs += 1;

    if (opportunity.spread.absolutePremiumPct < minPremiumPct) {
      coverage.belowMinPremium += 1;
      continue;
    }
    if (!directionAllowed(opportunity.direction, direction)) continue;

    opportunities.push(opportunity);
  }

  opportunities.sort((left, right) => {
    const edgeDelta = right.spread.netEdgePct - left.spread.netEdgePct;
    if (edgeDelta !== 0) return edgeDelta;
    const premiumDelta = right.spread.absolutePremiumPct - left.spread.absolutePremiumPct;
    if (premiumDelta !== 0) return premiumDelta;
    return right.confidence.score - left.confidence.score;
  });

  return {
    opportunities: opportunities.slice(0, limit),
    coverage,
  };
}
