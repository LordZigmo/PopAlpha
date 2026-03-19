/**
 * lib/data/homepage.ts
 *
 * Single server-side data loader for the homepage.
 * Uses dbPublic() only — no service-role access.
 *
 * Query plan (2 parallel batches, 7 queries total):
 *   Batch 1: positive 24h movers + negative 24h drops + 7d trending (parallel)
 *   Batch 2: canonical_cards metadata + canonical market pulse + images + sparklines (parallel)
 *   JS merge into HomepageData
 *
 * Why two data sources?
 *   - public_card_metrics is the homepage source of truth for current 24h movers/drops
 *   - public_variant_metrics still supplies the 7d sustained trending section
 */

import { getCanonicalMarketPulseMap, type CanonicalMarketPulse } from "@/lib/data/market";
import { dbPublic } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export type HomepageCard = {
  slug: string;
  name: string;
  set_name: string | null;
  year: number | null;
  market_price: number | null;
  change_pct: number | null;
  change_window: "24H" | "7D" | null;
  mover_tier: "hot" | "warming" | "cooling" | "cold" | null;
  image_url: string | null;
  sparkline_7d: number[];
};

export type HomepageData = {
  movers: HomepageCard[];
  high_confidence_movers: HomepageCard[];
  emerging_movers: HomepageCard[];
  losers: HomepageCard[];
  trending: HomepageCard[];
  as_of: string | null;
};

type ChangeCandidateRow = {
  canonical_slug: string;
  market_price: number | null;
  market_price_as_of: string | null;
  snapshot_count_30d: number | null;
  change_pct_24h: number | null;
  market_confidence_score: number | null;
  market_low_confidence: boolean | null;
  active_listings_7d: number | null;
};

type VariantRow = {
  canonical_slug: string;
  provider_trend_slope_7d: number | null;
  provider_price_changes_count_30d: number | null;
  updated_at: string;
};

type CardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
};

type ImageRow = {
  canonical_slug: string;
  image_url: string;
};

type SparklineRow = {
  canonical_slug: string;
  price: number | null;
};

type HomepageLogger = Pick<Console, "error" | "info">;

type HomepageDataOverrides = {
  positiveChangeRows?: ChangeCandidateRow[];
  negativeChangeRows?: ChangeCandidateRow[];
  trendingVariants?: VariantRow[];
  cards?: CardRow[];
  marketPulseMap?: Map<string, CanonicalMarketPulse>;
  images?: ImageRow[];
  sparklineRows?: SparklineRow[];
};

export type HomepageDataOptions = {
  now?: () => number;
  logger?: HomepageLogger;
  dataOverrides?: HomepageDataOverrides;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SECTION_LIMIT = 5;
/** Minimum 7d median to filter noise / $0 cards */
const MIN_PRICE = 0.5;
/** Homepage mover rails should only show cards above this market price. */
const MIN_MOVER_PRICE = 1;
/** Top movers must have market updates within this freshness window. */
const TOP_MOVER_MAX_AGE_HOURS = 24;
/** Minimum trade count for "sustained trending" vs noise */
const MIN_CHANGES_TRENDING = 3;
/** Over-fetch factor for candidate lists (we filter in JS) */
const CANDIDATE_FETCH_LIMIT = 80;
const SENTINEL_PRICES = new Set([23456.78]);
const MIN_MOVER_CHANGE_PCT = 2.5;
const MIN_CONFIDENCE_SCORE = 45;
const HIGH_CONF_LIQUIDITY_MIN = 6;
const EMERGING_LIQUIDITY_MAX = 5;
const MOVER_LOOKBACK_DAYS = 30;
const MIN_MOVER_COVERAGE_RATIO = 0.9;
const MIN_MOVER_SNAPSHOT_COUNT_30D = Math.ceil(MOVER_LOOKBACK_DAYS * MIN_MOVER_COVERAGE_RATIO);

// ── Loader ──────────────────────────────────────────────────────────────────

const EMPTY: HomepageData = {
  movers: [],
  high_confidence_movers: [],
  emerging_movers: [],
  losers: [],
  trending: [],
  as_of: null,
};

const DEFAULT_LOGGER: HomepageLogger = console;

function compareMovementMagnitude(a: HomepageCard, b: HomepageCard): number {
  const aMove = typeof a.change_pct === "number" && Number.isFinite(a.change_pct) ? Math.abs(a.change_pct) : -1;
  const bMove = typeof b.change_pct === "number" && Number.isFinite(b.change_pct) ? Math.abs(b.change_pct) : -1;

  if (aMove !== bMove) return bMove - aMove;

  const aPrice = typeof a.market_price === "number" && Number.isFinite(a.market_price) ? a.market_price : -1;
  const bPrice = typeof b.market_price === "number" && Number.isFinite(b.market_price) ? b.market_price : -1;
  if (aPrice !== bPrice) return bPrice - aPrice;

  return a.name.localeCompare(b.name);
}

function compareChangeDescending(a: HomepageCard, b: HomepageCard): number {
  const aChange = typeof a.change_pct === "number" && Number.isFinite(a.change_pct) ? a.change_pct : Number.NEGATIVE_INFINITY;
  const bChange = typeof b.change_pct === "number" && Number.isFinite(b.change_pct) ? b.change_pct : Number.NEGATIVE_INFINITY;
  if (aChange !== bChange) return bChange - aChange;
  return compareMovementMagnitude(a, b);
}

function compareChangeAscending(a: HomepageCard, b: HomepageCard): number {
  const aChange = typeof a.change_pct === "number" && Number.isFinite(a.change_pct) ? a.change_pct : Number.POSITIVE_INFINITY;
  const bChange = typeof b.change_pct === "number" && Number.isFinite(b.change_pct) ? b.change_pct : Number.POSITIVE_INFINITY;
  if (aChange !== bChange) return aChange - bChange;
  return compareMovementMagnitude(a, b);
}

function deriveSparklineChangePct(points: number[]): number | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first > 0) || !Number.isFinite(first) || !Number.isFinite(last)) return null;
  return ((last - first) / first) * 100;
}

function buildChangeCoverage(section: string, cards: HomepageCard[]) {
  const total = cards.length;
  const missing = cards.filter((card) => card.change_pct == null || !Number.isFinite(card.change_pct)).length;
  const present = Math.max(0, total - missing);
  const missingPct = total > 0 ? Number(((missing / total) * 100).toFixed(1)) : 0;
  return { section, total, present, missing, missingPct };
}

function hoursSince(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / (60 * 60 * 1000));
}

function computeLiquidityWeight(activeListings7d: number | null | undefined): number {
  if (!Number.isFinite(activeListings7d ?? NaN)) return 0.5;
  const value = Math.max(0, activeListings7d ?? 0);
  if (value <= 1) return 0.35;
  if (value <= 3) return 0.55;
  if (value <= 5) return 0.75;
  if (value <= 10) return 0.95;
  if (value <= 20) return 1.1;
  return 1.25;
}

function dedupVariants(rows: VariantRow[], limit: number): VariantRow[] {
  const seen = new Set<string>();
  const out: VariantRow[] = [];
  for (const row of rows) {
    if (seen.has(row.canonical_slug)) continue;
    seen.add(row.canonical_slug);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getHomepageData(options: HomepageDataOptions = {}): Promise<HomepageData> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? DEFAULT_LOGGER;
  const overrides = options.dataOverrides ?? null;
  let db: ReturnType<typeof dbPublic> | undefined;

  if (!overrides) {
    try {
      db = dbPublic();
    } catch (err) {
      logger.error("[homepage] dbPublic() init failed:", err);
      return EMPTY;
    }
  }

  try {
    const nowMs = now();
    const freshnessCutoffIso = new Date(nowMs - TOP_MOVER_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

    let positiveChangeRows: ChangeCandidateRow[] = [];
    let negativeChangeRows: ChangeCandidateRow[] = [];
    let trendingVariants: VariantRow[] = [];
    let cardsRows: CardRow[] = [];
    let marketPulseMap = new Map<string, CanonicalMarketPulse>();
    let imageRows: ImageRow[] = [];
    let sparklineRows: SparklineRow[] = [];

    if (overrides) {
      positiveChangeRows = overrides.positiveChangeRows ?? [];
      negativeChangeRows = overrides.negativeChangeRows ?? [];
      trendingVariants = dedupVariants(overrides.trendingVariants ?? [], CANDIDATE_FETCH_LIMIT);
      cardsRows = overrides.cards ?? [];
      marketPulseMap = overrides.marketPulseMap ?? new Map<string, CanonicalMarketPulse>();
      imageRows = overrides.images ?? [];
      sparklineRows = overrides.sparklineRows ?? [];
    } else {
      const client = db;
      if (!client) return EMPTY;

      // ── Batch 1: movers + variant-level trend data ────────────────────────
      const [positiveChangeResult, negativeChangeResult, trendingVariantResult] = await Promise.all([
        // 1. Top movers — fresh positive 24h moves from canonical card metrics
        client
          .from("public_card_metrics")
          .select("canonical_slug, market_price, market_price_as_of, snapshot_count_30d, change_pct_24h, market_confidence_score, market_low_confidence, active_listings_7d")
          .eq("grade", "RAW")
          .is("printing_id", null)
          .gte("market_price", MIN_MOVER_PRICE)
          .gte("market_price_as_of", freshnessCutoffIso)
          .gte("snapshot_count_30d", MIN_MOVER_SNAPSHOT_COUNT_30D)
          .not("change_pct_24h", "is", null)
          .gt("change_pct_24h", 0)
          .order("change_pct_24h", { ascending: false })
          .order("market_confidence_score", { ascending: false })
          .limit(CANDIDATE_FETCH_LIMIT),

        // 2. Biggest drops — fresh negative 24h moves from canonical card metrics
        client
          .from("public_card_metrics")
          .select("canonical_slug, market_price, market_price_as_of, snapshot_count_30d, change_pct_24h, market_confidence_score, market_low_confidence, active_listings_7d")
          .eq("grade", "RAW")
          .is("printing_id", null)
          .gte("market_price", MIN_MOVER_PRICE)
          .gte("market_price_as_of", freshnessCutoffIso)
          .gte("snapshot_count_30d", MIN_MOVER_SNAPSHOT_COUNT_30D)
          .not("change_pct_24h", "is", null)
          .lt("change_pct_24h", 0)
          .order("change_pct_24h", { ascending: true })
          .order("market_confidence_score", { ascending: false })
          .limit(CANDIDATE_FETCH_LIMIT),

        // 3. Trending — positive slope with activity from variant_metrics
        client
          .from("public_variant_metrics")
          .select("canonical_slug, provider_trend_slope_7d, provider_price_changes_count_30d, updated_at")
          .eq("provider", "JUSTTCG")
          .eq("grade", "RAW")
          .gt("provider_trend_slope_7d", 0)
          .gte("provider_price_changes_count_30d", MIN_CHANGES_TRENDING)
          .order("provider_trend_slope_7d", { ascending: false })
          .limit(CANDIDATE_FETCH_LIMIT),
      ]);

      if (positiveChangeResult.error) logger.error("[homepage] movers_24h", positiveChangeResult.error.message);
      if (negativeChangeResult.error) logger.error("[homepage] drops_24h", negativeChangeResult.error.message);
      if (trendingVariantResult.error) logger.error("[homepage] trending", trendingVariantResult.error.message);

      positiveChangeRows = (positiveChangeResult.data ?? []) as ChangeCandidateRow[];
      negativeChangeRows = (negativeChangeResult.data ?? []) as ChangeCandidateRow[];
      trendingVariants = dedupVariants((trendingVariantResult.data ?? []) as VariantRow[], CANDIDATE_FETCH_LIMIT);
    }

    // ── Collect all unique slugs ──────────────────────────────────────────
    const allSlugs = new Set<string>();
    for (const r of positiveChangeRows) allSlugs.add(r.canonical_slug);
    for (const r of negativeChangeRows) allSlugs.add(r.canonical_slug);
    for (const r of trendingVariants) allSlugs.add(r.canonical_slug);

    if (allSlugs.size === 0) return EMPTY;

    const slugArray = [...allSlugs];

    if (!overrides) {
      const client = db;
      if (!client) return EMPTY;

      // ── Batch 2: card metadata + prices (with change pcts) + images ────
      const [cardsResult, loadedMarketPulseMap, imagesResult, sparklineResult] = await Promise.all([
        client
          .from("canonical_cards")
          .select("slug, canonical_name, set_name, year")
          .in("slug", slugArray),

        getCanonicalMarketPulseMap(client, slugArray),

        client
          .from("card_printings")
          .select("canonical_slug, image_url")
          .in("canonical_slug", slugArray)
          .eq("language", "EN")
          .not("image_url", "is", null)
          .limit(slugArray.length * 3),

        client
          .from("public_price_history")
          .select("canonical_slug, ts, price")
          .in("canonical_slug", slugArray)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "7d")
          .order("ts", { ascending: false })
          .limit(Math.max(slugArray.length * 24, 120)),
      ]);

      if (cardsResult.error) logger.error("[homepage] cards", cardsResult.error.message);
      if (imagesResult.error) logger.error("[homepage] images", imagesResult.error.message);
      if (sparklineResult.error) logger.error("[homepage] sparkline", sparklineResult.error.message);

      cardsRows = (cardsResult.data ?? []) as CardRow[];
      marketPulseMap = loadedMarketPulseMap;
      imageRows = (imagesResult.data ?? []) as ImageRow[];
      sparklineRows = (sparklineResult.data ?? []) as SparklineRow[];
    }

    // ── Build lookup maps ─────────────────────────────────────────────────
    const cardMap = new Map<string, CardRow>();
    for (const c of cardsRows) {
      cardMap.set(c.slug, c);
    }

    const imageMap = new Map<string, string>();
    for (const row of imageRows) {
      if (!imageMap.has(row.canonical_slug) && row.image_url) {
        imageMap.set(row.canonical_slug, row.image_url);
      }
    }

    const sparklineMap = new Map<string, number[]>();
    for (const row of sparklineRows) {
      if (!row.canonical_slug || row.price == null) continue;
      const current = sparklineMap.get(row.canonical_slug) ?? [];
      if (current.length >= 7) continue;
      current.push(row.price);
      sparklineMap.set(row.canonical_slug, current);
    }
    for (const [slug, points] of sparklineMap.entries()) {
      sparklineMap.set(slug, [...points].reverse());
    }

    // ── Assemble helpers ──────────────────────────────────────────────────
    function toCard(
      slug: string,
      overrides: {
        fallbackPrice?: number | null;
        mover_tier?: HomepageCard["mover_tier"];
        changePct?: number | null;
        changeWindow?: "24H" | "7D" | null;
        preferOverrideChange?: boolean;
        allowSparklineFallback?: boolean;
      } = {},
    ): HomepageCard {
      const card = cardMap.get(slug);
      const marketPulse = marketPulseMap.get(slug);
      const sparkline = sparklineMap.get(slug) ?? [];
      const fallbackChangePct = overrides.allowSparklineFallback === false ? null : deriveSparklineChangePct(sparkline);
      const overrideChangePct = typeof overrides.changePct === "number" && Number.isFinite(overrides.changePct)
        ? overrides.changePct
        : null;
      const marketChangePct = typeof marketPulse?.changePct === "number" && Number.isFinite(marketPulse.changePct)
        ? marketPulse.changePct
        : null;
      let selectedChangePct: number | null = null;
      let selectedChangeWindow: "24H" | "7D" | null = null;

      if (overrides.preferOverrideChange && overrideChangePct !== null) {
        selectedChangePct = overrideChangePct;
        selectedChangeWindow = overrides.changeWindow ?? null;
      } else if (marketChangePct !== null) {
        selectedChangePct = marketChangePct;
        selectedChangeWindow = marketPulse?.changeWindow ?? null;
      } else if (overrideChangePct !== null) {
        selectedChangePct = overrideChangePct;
        selectedChangeWindow = overrides.changeWindow ?? null;
      } else if (fallbackChangePct !== null) {
        selectedChangePct = fallbackChangePct;
        selectedChangeWindow = "7D";
      }
      return {
        slug,
        name: card?.canonical_name ?? slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        market_price: marketPulse?.marketPrice ?? overrides.fallbackPrice ?? null,
        change_pct: selectedChangePct,
        change_window: selectedChangeWindow,
        image_url: imageMap.get(slug) ?? null,
        mover_tier: overrides.mover_tier ?? null,
        sparkline_7d: sparkline,
      };
    }

    // ── Movers: strict 24h cards with fresh market prices ─────────────────
    const highConfidenceMoversOut: HomepageCard[] = [];
    const emergingMoversOut: HomepageCard[] = [];
    const allMoversOut: HomepageCard[] = [];
    const seenMoverSlugs = new Set<string>();
    const pushMoverIfEligible = (r: ChangeCandidateRow): boolean => {
      if (seenMoverSlugs.has(r.canonical_slug)) return false;
      const marketPulse = marketPulseMap.get(r.canonical_slug);
      if (!marketPulse) return false;
      const marketPrice = marketPulse.marketPrice ?? r.market_price ?? null;
      if (marketPrice == null) return false;
      if (SENTINEL_PRICES.has(Number(marketPrice.toFixed(2)))) return false;
      if (marketPrice < MIN_MOVER_PRICE) return false;
      const snapshotCount30d = marketPulse.snapshotCount30d ?? r.snapshot_count_30d ?? 0;
      if (snapshotCount30d < MIN_MOVER_SNAPSHOT_COUNT_30D) return false;
      const changePct = typeof r.change_pct_24h === "number" && Number.isFinite(r.change_pct_24h)
        ? Number(r.change_pct_24h.toFixed(2))
        : marketPulse.changePct24h;
      if (changePct == null || changePct < MIN_MOVER_CHANGE_PCT) return false;
      const confidenceScore = marketPulse.confidenceScore ?? r.market_confidence_score ?? 0;
      const stalenessHours = hoursSince(marketPulse.marketPriceAsOf ?? r.market_price_as_of ?? null, nowMs);
      const isStale = stalenessHours === null || stalenessHours > TOP_MOVER_MAX_AGE_HOURS;
      const lowConfidence = marketPulse.lowConfidence === true || r.market_low_confidence === true || confidenceScore < MIN_CONFIDENCE_SCORE;
      if (isStale || lowConfidence) return false;
      const activeListings7d = marketPulse.activeListings7d ?? r.active_listings_7d ?? 0;
      const liquidityWeight = computeLiquidityWeight(activeListings7d);
      const compositeScore = Math.abs(changePct) * (confidenceScore / 100) * liquidityWeight;
      if (!(compositeScore > 0)) return false;
      const moverCard = toCard(r.canonical_slug, {
        fallbackPrice: r.market_price,
        mover_tier: activeListings7d >= HIGH_CONF_LIQUIDITY_MIN ? "hot" : "warming",
        changePct,
        changeWindow: "24H",
        preferOverrideChange: true,
        allowSparklineFallback: false,
      });
      if (activeListings7d >= HIGH_CONF_LIQUIDITY_MIN) {
        highConfidenceMoversOut.push(moverCard);
      } else if (activeListings7d <= EMERGING_LIQUIDITY_MAX) {
        emergingMoversOut.push(moverCard);
      } else {
        highConfidenceMoversOut.push(moverCard);
      }
      allMoversOut.push(moverCard);
      seenMoverSlugs.add(r.canonical_slug);
      return true;
    };

    for (const r of positiveChangeRows) {
      pushMoverIfEligible(r);
      if (highConfidenceMoversOut.length >= SECTION_LIMIT && emergingMoversOut.length >= SECTION_LIMIT) break;
    }
    highConfidenceMoversOut.sort(compareChangeDescending);
    highConfidenceMoversOut.splice(SECTION_LIMIT);
    emergingMoversOut.sort(compareChangeDescending);
    emergingMoversOut.splice(SECTION_LIMIT);
    allMoversOut.sort(compareChangeDescending);
    const moversOut = allMoversOut.slice(0, SECTION_LIMIT);

    // ── Biggest drops: strict 24h losers only ─────────────────────────────
    const losersOut: HomepageCard[] = [];
    for (const r of negativeChangeRows) {
      const marketPulse = marketPulseMap.get(r.canonical_slug);
      if (!marketPulse) continue;
      const price = marketPulse.marketPrice ?? r.market_price ?? null;
      if (price == null || price < MIN_MOVER_PRICE) continue;
      const snapshotCount30d = marketPulse.snapshotCount30d ?? r.snapshot_count_30d ?? 0;
      if (snapshotCount30d < MIN_MOVER_SNAPSHOT_COUNT_30D) continue;
      const stalenessHours = hoursSince(marketPulse.marketPriceAsOf ?? r.market_price_as_of ?? null, nowMs);
      if (stalenessHours === null || stalenessHours > TOP_MOVER_MAX_AGE_HOURS) continue;
      const confidenceScore = marketPulse.confidenceScore ?? r.market_confidence_score ?? 0;
      if (marketPulse.lowConfidence === true || r.market_low_confidence === true || confidenceScore < MIN_CONFIDENCE_SCORE) continue;
      const changePct = typeof r.change_pct_24h === "number" && Number.isFinite(r.change_pct_24h)
        ? Number(r.change_pct_24h.toFixed(2))
        : marketPulse.changePct24h;
      if (changePct == null || changePct >= 0) continue;
      losersOut.push(toCard(r.canonical_slug, {
        fallbackPrice: r.market_price,
        changePct,
        changeWindow: "24H",
        preferOverrideChange: true,
        allowSparklineFallback: false,
      }));
    }
    losersOut.sort(compareChangeAscending);
    losersOut.splice(SECTION_LIMIT);

    // ── Trending: filter to cards with real prices above MIN_PRICE ────────
    const trendingOut: HomepageCard[] = [];
    for (const r of trendingVariants) {
      const price = marketPulseMap.get(r.canonical_slug)?.marketPrice ?? null;
      if (price == null || price < MIN_PRICE) continue;
      const trendPct = Number.isFinite(r.provider_trend_slope_7d ?? NaN)
        ? Number((r.provider_trend_slope_7d as number).toFixed(2))
        : null;
      trendingOut.push(toCard(r.canonical_slug, {
        changePct: trendPct,
        changeWindow: trendPct !== null ? "7D" : null,
        preferOverrideChange: true,
        allowSparklineFallback: false,
      }));
    }
    trendingOut.sort(compareChangeDescending);
    trendingOut.splice(SECTION_LIMIT);

    // ── Derive as_of ──────────────────────────────────────────────────────
    const timestamps = [
      ...positiveChangeRows.map((r) => r.market_price_as_of),
      ...negativeChangeRows.map((r) => r.market_price_as_of),
      ...trendingVariants.map((r) => r.updated_at),
    ].filter(Boolean) as string[];
    const as_of = timestamps.length > 0 ? timestamps.sort().reverse()[0] : null;

    const coverage = [
      buildChangeCoverage("movers", moversOut),
      buildChangeCoverage("movers_high_confidence", highConfidenceMoversOut),
      buildChangeCoverage("movers_emerging", emergingMoversOut),
      buildChangeCoverage("losers", losersOut),
      buildChangeCoverage("trending", trendingOut),
    ];
    logger.info("[homepage.telemetry.change_coverage]", JSON.stringify({
      asOf: as_of,
      coverage,
    }));

    return {
      movers: moversOut,
      high_confidence_movers: highConfidenceMoversOut,
      emerging_movers: emergingMoversOut,
      losers: losersOut,
      trending: trendingOut,
      as_of,
    };

  } catch (err) {
    logger.error("[homepage] getHomepageData failed:", err);
    return EMPTY;
  }
}
