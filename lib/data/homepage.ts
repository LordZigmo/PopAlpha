/**
 * lib/data/homepage.ts
 *
 * Single server-side data loader for the homepage.
 * Uses dbPublic() only — no service-role access.
 *
 * Query plan (2 parallel batches, 7 queries total):
 *   Batch 1: live movers + live pullbacks + 7d trending (parallel)
 *   Batch 2: canonical_cards metadata + canonical market pulse + images + sparklines (parallel)
 *   JS merge into HomepageData
 *
 * Why two data sources?
 *   - public_card_metrics is the homepage source of truth for live mover/pullback rails
 *   - public_variant_metrics still supplies the 7d sustained trending section
 */

import {
  getCanonicalMarketPulseMap,
  resolveCanonicalMarketPulse,
  type CanonicalMarketPulse,
} from "@/lib/data/market";
import type { MarketDirection } from "@/lib/data/market-strength";
import { dbPublic } from "@/lib/db";
import { resolveCardImage } from "@/lib/images/resolve";
import { isPhysicalPokemonSet } from "@/lib/sets/physical";

// ── Types ────────────────────────────────────────────────────────────────────

export type HomepageSignalWindow = "24H" | "7D";

export type HomepageCard = {
  slug: string;
  name: string;
  set_name: string | null;
  year: number | null;
  market_price: number | null;
  change_pct: number | null;
  change_window: HomepageSignalWindow | null;
  confidence_score: number | null;
  low_confidence: boolean | null;
  market_strength_score: number | null;
  market_direction: MarketDirection | null;
  mover_tier: "hot" | "warming" | "cooling" | "cold" | null;
  image_url: string | null;
  image_thumb_url: string | null;
  sparkline_7d: number[];
  // Phase 2: density metrics surfaced on homepage cards
  sales_count_30d: number | null;
  active_listings_7d: number | null;
  updated_at: string | null;
};

export type HomepageWindowedCards = Record<HomepageSignalWindow, HomepageCard[]>;

export type HomepageSignalBoardData = {
  top_movers: HomepageWindowedCards;
  biggest_drops: HomepageWindowedCards;
  momentum: HomepageWindowedCards;
  // Phase 2: dedicated conviction signals (non-windowed — these are cached,
  // not time-sliced like top_movers/biggest_drops).
  unusual_volume: HomepageCard[];
  breakouts: HomepageCard[];
};

export type HomepageData = {
  movers: HomepageCard[];
  high_confidence_movers: HomepageCard[];
  emerging_movers: HomepageCard[];
  losers: HomepageCard[];
  trending: HomepageCard[];
  signal_board: HomepageSignalBoardData;
  as_of: string | null;
  prices_refreshed_today: number | null;
  tracked_cards_with_live_price: number | null;
};

type ChangeCandidateRow = {
  canonical_slug: string;
  market_price: number | null;
  market_price_as_of: string | null;
  snapshot_count_30d: number | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
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
  primary_image_url?: string | null;
  mirrored_primary_image_url?: string | null;
  mirrored_primary_thumb_url?: string | null;
};

type ImageRow = {
  canonical_slug: string;
  image_url: string;
  mirrored_image_url?: string | null;
  mirrored_thumb_url?: string | null;
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
  pricesRefreshedToday?: number | null;
  trackedCardsWithLivePrice?: number | null;
};

export type HomepageDataOptions = {
  now?: () => number;
  logger?: HomepageLogger;
  dataOverrides?: HomepageDataOverrides;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SECTION_LIMIT = 5;
const SIGNAL_WINDOWS: HomepageSignalWindow[] = ["24H", "7D"];
/** Minimum 7d median to filter noise / $0 cards */
const MIN_PRICE = 0.5;
/** Homepage mover rails should only show cards above this market price. */
const MIN_MOVER_PRICE = 1;
/** Homepage live rails should tolerate missed runs and keep using recent real market data. */
const RECENT_MARKET_MAX_AGE_HOURS = 72;
/** Homepage hero freshness count is a true 24-hour stat. */
const REFRESHED_TODAY_MAX_AGE_HOURS = 24;
/** Minimum trade count for "sustained trending" vs noise */
const MIN_CHANGES_TRENDING = 3;
/** Over-fetch factor for candidate lists (we filter in JS) */
const CANDIDATE_FETCH_LIMIT = 80;
const LIVE_CANDIDATE_FETCH_LIMIT = CANDIDATE_FETCH_LIMIT * 3;
const BATCH_LOOKUP_SLUG_LIMIT = 40;
const SENTINEL_PRICES = new Set([23456.78]);
const MIN_MOVER_CHANGE_PCT = 2.5;
const MIN_CONFIDENCE_SCORE = 45;
const HIGH_CONF_LIQUIDITY_MIN = 6;
const EMERGING_LIQUIDITY_MAX = 5;
const MOVER_LOOKBACK_DAYS = 30;
const MIN_MOVER_COVERAGE_RATIO = 0.9;
const MIN_MOVER_SNAPSHOT_COUNT_30D = Math.ceil(MOVER_LOOKBACK_DAYS * MIN_MOVER_COVERAGE_RATIO);

function createEmptyWindowedCards(): HomepageWindowedCards {
  return { "24H": [], "7D": [] };
}

// ── Daily-computed top movers override ──────────────────────────────────────
//
// The homepage's top_movers + biggest_drops rails prefer a daily-computed
// list over the live on-read computation. The daily list is populated by
// the compute_daily_top_movers RPC (migration 20260419230000) once per day
// when catalog-wide fresh_24h coverage is high enough, with a set-diversity
// constraint (max 2 per set) to avoid clustering.
//
// See app/api/cron/compute-daily-top-movers/route.ts for the producer.
// Homepage falls back to yesterday's list if today's doesn't exist yet;
// falls through to live on-read computation if neither exists.

type DailyMoverJoinedCard = {
  canonical_name: string | null;
  year: number | null;
  primary_image_url: string | null;
  mirrored_primary_image_url: string | null;
  mirrored_primary_thumb_url: string | null;
};

type DailyMoverRow = {
  rank: number;
  canonical_slug: string;
  change_pct: number;
  change_window: "24H" | "7D";
  market_price: number;
  market_price_as_of: string;
  set_name: string | null;
  active_listings_7d: number | null;
  confidence_score: number | null;
  // Supabase returns joined rows as arrays; the FK is 1:1 so we only use the first.
  canonical_cards: DailyMoverJoinedCard[] | DailyMoverJoinedCard | null;
};

type DailyMoverKind = "gainer" | "loser" | "momentum_24h" | "momentum_7d";

type DailyMoverBundle = {
  gainers: HomepageCard[];
  losers: HomepageCard[];
  momentum_24h: HomepageCard[];
  momentum_7d: HomepageCard[];
  computed_at_date: string | null;
};

async function loadDailyTopMoversBundle(
  client: NonNullable<ReturnType<typeof dbPublic>>,
): Promise<DailyMoverBundle> {
  // Take the most recent date that has any rows. Preferring today, fall
  // back to yesterday or older if the cron hasn't run yet today.
  const { data: latestDateRow, error: latestDateError } = await client
    .from("daily_top_movers")
    .select("computed_at_date")
    .order("computed_at_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ computed_at_date: string }>();

  if (latestDateError || !latestDateRow?.computed_at_date) {
    return { gainers: [], losers: [], momentum_24h: [], momentum_7d: [], computed_at_date: null };
  }

  const computedDate = latestDateRow.computed_at_date;
  const { data, error } = await client
    .from("daily_top_movers")
    .select(
      "rank, kind, canonical_slug, change_pct, change_window, market_price, market_price_as_of, set_name, active_listings_7d, confidence_score, canonical_cards(canonical_name, year, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url)",
    )
    .eq("computed_at_date", computedDate)
    .order("kind", { ascending: true })
    .order("rank", { ascending: true });

  if (error || !data) {
    return { gainers: [], losers: [], momentum_24h: [], momentum_7d: [], computed_at_date: computedDate };
  }

  const toCard = (row: DailyMoverRow & { kind: DailyMoverKind }): HomepageCard => {
    const canonicalCard: DailyMoverJoinedCard | null = Array.isArray(row.canonical_cards)
      ? (row.canonical_cards[0] ?? null)
      : (row.canonical_cards ?? null);
    const image = resolveCardImage({
      primary_image_url: canonicalCard?.primary_image_url ?? null,
      mirrored_primary_image_url: canonicalCard?.mirrored_primary_image_url ?? null,
      mirrored_primary_thumb_url: canonicalCard?.mirrored_primary_thumb_url ?? null,
    });
    const highConfidence = (row.active_listings_7d ?? 0) >= HIGH_CONF_LIQUIDITY_MIN;
    return {
      slug: row.canonical_slug,
      name: canonicalCard?.canonical_name ?? row.canonical_slug,
      set_name: row.set_name,
      year: canonicalCard?.year ?? null,
      market_price: row.market_price,
      change_pct: row.change_pct,
      change_window: row.change_window,
      confidence_score: row.confidence_score,
      low_confidence: false,
      market_strength_score: null,
      market_direction: null,
      mover_tier:
        row.kind === "loser"
          ? (highConfidence ? "cooling" : "cold")
          // Gainers and momentum lean upward; warmth tracks liquidity.
          : (highConfidence ? "hot" : "warming"),
      image_url: image.full,
      image_thumb_url: image.thumb,
      sparkline_7d: [],
      sales_count_30d: null,
      active_listings_7d: row.active_listings_7d,
      updated_at: row.market_price_as_of,
    };
  };

  const gainers: HomepageCard[] = [];
  const losers: HomepageCard[] = [];
  const momentum_24h: HomepageCard[] = [];
  const momentum_7d: HomepageCard[] = [];
  for (const raw of (data ?? []) as unknown as Array<DailyMoverRow & { kind: DailyMoverKind }>) {
    const card = toCard(raw);
    switch (raw.kind) {
      case "gainer": gainers.push(card); break;
      case "loser": losers.push(card); break;
      case "momentum_24h": momentum_24h.push(card); break;
      case "momentum_7d": momentum_7d.push(card); break;
    }
  }

  return { gainers, losers, momentum_24h, momentum_7d, computed_at_date: computedDate };
}

function createEmptySignalBoard(): HomepageSignalBoardData {
  return {
    top_movers: createEmptyWindowedCards(),
    biggest_drops: createEmptyWindowedCards(),
    momentum: createEmptyWindowedCards(),
    unusual_volume: [],
    breakouts: [],
  };
}

// ── Loader ──────────────────────────────────────────────────────────────────

const EMPTY: HomepageData = {
  movers: [],
  high_confidence_movers: [],
  emerging_movers: [],
  losers: [],
  trending: [],
  signal_board: createEmptySignalBoard(),
  as_of: null,
  prices_refreshed_today: null,
  tracked_cards_with_live_price: null,
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

function dedupeHomepageCards(cards: HomepageCard[]): HomepageCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.slug)) return false;
    seen.add(card.slug);
    return true;
  });
}

function combineHomepageCards(groups: HomepageCard[][], limit = SECTION_LIMIT): HomepageCard[] {
  return dedupeHomepageCards(groups.flat()).slice(0, limit);
}

function hoursSince(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / (60 * 60 * 1000));
}

function toFiniteChange(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function buildFallbackPulseFromCandidate(row: ChangeCandidateRow): CanonicalMarketPulse {
  return resolveCanonicalMarketPulse({
    market_price: row.market_price,
    market_price_as_of: row.market_price_as_of,
    active_listings_7d: row.active_listings_7d,
    snapshot_count_30d: row.snapshot_count_30d,
    market_confidence_score: row.market_confidence_score,
    market_low_confidence: row.market_low_confidence,
    change_pct_24h: row.change_pct_24h,
    change_pct_7d: row.change_pct_7d,
  });
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

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    out.push(values.slice(index, index + chunkSize));
  }
  return out;
}

type DirectionalChange = {
  value: number;
  window: HomepageSignalWindow;
};

function selectDirectionalChangeForWindow(
  row: ChangeCandidateRow,
  direction: "positive" | "negative",
  window: HomepageSignalWindow,
): DirectionalChange | null {
  const rawChange = window === "24H" ? row.change_pct_24h : row.change_pct_7d;
  const change = toFiniteChange(rawChange);
  if (change === null) return null;
  if (direction === "positive" && change <= 0) return null;
  if (direction === "negative" && change >= 0) return null;
  return { value: Number(change.toFixed(2)), window };
}

function selectDirectionalChange(
  row: ChangeCandidateRow,
  direction: "positive" | "negative",
): DirectionalChange | null {
  return selectDirectionalChangeForWindow(row, direction, "24H")
    ?? selectDirectionalChangeForWindow(row, direction, "7D");
}

function compareDirectionalCandidates(
  left: ChangeCandidateRow,
  right: ChangeCandidateRow,
  direction: "positive" | "negative",
): number {
  const leftChange = selectDirectionalChange(left, direction);
  const rightChange = selectDirectionalChange(right, direction);
  if (!leftChange && !rightChange) return 0;
  if (!leftChange) return 1;
  if (!rightChange) return -1;

  const leftWindowRank = leftChange.window === "24H" ? 0 : 1;
  const rightWindowRank = rightChange.window === "24H" ? 0 : 1;
  if (leftWindowRank !== rightWindowRank) return leftWindowRank - rightWindowRank;

  const changeDelta = Math.abs(rightChange.value) - Math.abs(leftChange.value);
  if (changeDelta !== 0) return changeDelta;

  const confidenceDelta = (right.market_confidence_score ?? 0) - (left.market_confidence_score ?? 0);
  if (confidenceDelta !== 0) return confidenceDelta;

  const listingDelta = (right.active_listings_7d ?? 0) - (left.active_listings_7d ?? 0);
  if (listingDelta !== 0) return listingDelta;

  return (right.market_price ?? 0) - (left.market_price ?? 0);
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
    const recentMarketCutoffIso = new Date(nowMs - RECENT_MARKET_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
    const refreshedTodayCutoffIso = new Date(nowMs - REFRESHED_TODAY_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

    let positiveChangeRows: ChangeCandidateRow[] = [];
    let negativeChangeRows: ChangeCandidateRow[] = [];
    let trendingVariants: VariantRow[] = [];
    let cardsRows: CardRow[] = [];
    let marketPulseMap = new Map<string, CanonicalMarketPulse>();
    let imageRows: ImageRow[] = [];
    let sparklineRows: SparklineRow[] = [];
    let pricesRefreshedToday: number | null = null;
    let trackedCardsWithLivePrice: number | null = null;

    if (overrides) {
      positiveChangeRows = overrides.positiveChangeRows ?? [];
      negativeChangeRows = overrides.negativeChangeRows ?? [];
      trendingVariants = dedupVariants(overrides.trendingVariants ?? [], CANDIDATE_FETCH_LIMIT);
      cardsRows = overrides.cards ?? [];
      marketPulseMap = overrides.marketPulseMap ?? new Map<string, CanonicalMarketPulse>();
      imageRows = overrides.images ?? [];
      sparklineRows = overrides.sparklineRows ?? [];
      pricesRefreshedToday = overrides.pricesRefreshedToday ?? null;
      trackedCardsWithLivePrice = overrides.trackedCardsWithLivePrice ?? null;
    } else {
      const client = db;
      if (!client) return EMPTY;

      // ── Batch 1: movers + variant-level trend data + canonical counts ──
      const [positiveChangeResult, negativeChangeResult, trendingVariantResult, refreshedCountResult, trackedCountResult] = await Promise.all([
        // 1. Top movers — prefer 24h, then fall back to 7d when 24h is unavailable.
        // Order by the change itself (not `market_price_as_of`) so the fallback
        // is stable between requests: "biggest mover wins" instead of
        // "whichever card the refresh cron just touched wins". The freshness
        // filter is already applied via `market_price_as_of >= recentMarketCutoffIso`.
        client
          .from("public_card_metrics")
          .select("canonical_slug, market_price, market_price_as_of, snapshot_count_30d, change_pct_24h, change_pct_7d, market_confidence_score, market_low_confidence, active_listings_7d")
          .eq("grade", "RAW")
          .is("printing_id", null)
          .gte("market_price", MIN_MOVER_PRICE)
          .gte("market_price_as_of", recentMarketCutoffIso)
          .or("change_pct_24h.gt.0,change_pct_7d.gt.0")
          .order("change_pct_24h", { ascending: false, nullsFirst: false })
          .order("change_pct_7d", { ascending: false, nullsFirst: false })
          .order("market_confidence_score", { ascending: false })
          .limit(LIVE_CANDIDATE_FETCH_LIMIT),

        // 2. Biggest drops — prefer 24h, then fall back to 7d when 24h is unavailable.
        // Order by change ascending (most negative first) for the same
        // stability reason as top_movers.
        client
          .from("public_card_metrics")
          .select("canonical_slug, market_price, market_price_as_of, snapshot_count_30d, change_pct_24h, change_pct_7d, market_confidence_score, market_low_confidence, active_listings_7d")
          .eq("grade", "RAW")
          .is("printing_id", null)
          .gte("market_price", MIN_MOVER_PRICE)
          .gte("market_price_as_of", recentMarketCutoffIso)
          .or("change_pct_24h.lt.0,change_pct_7d.lt.0")
          .order("change_pct_24h", { ascending: true, nullsFirst: false })
          .order("change_pct_7d", { ascending: true, nullsFirst: false })
          .order("market_confidence_score", { ascending: false })
          .limit(LIVE_CANDIDATE_FETCH_LIMIT),

        // 3. Trending — positive slope with activity from variant_metrics
        client
          .from("public_variant_metrics")
          .select("canonical_slug, provider_trend_slope_7d, provider_price_changes_count_30d, updated_at")
          .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
          .eq("grade", "RAW")
          .gt("provider_trend_slope_7d", 0)
          .gte("provider_price_changes_count_30d", MIN_CHANGES_TRENDING)
          .order("provider_trend_slope_7d", { ascending: false })
          .limit(CANDIDATE_FETCH_LIMIT),

        // 4. Count of cards with a fresh price update in the last 24h
        client
          .from("public_card_metrics")
          .select("canonical_slug", { count: "exact", head: true })
          .eq("grade", "RAW")
          .is("printing_id", null)
          .not("market_price", "is", null)
          .gte("market_price_as_of", refreshedTodayCutoffIso),

        // 5. Count of canonical RAW cards with a live market price
        client
          .from("public_card_metrics")
          .select("canonical_slug", { count: "exact", head: true })
          .eq("grade", "RAW")
          .is("printing_id", null)
          .not("market_price", "is", null),
      ]);

      if (positiveChangeResult.error) logger.error("[homepage] movers_24h", positiveChangeResult.error.message);
      if (negativeChangeResult.error) logger.error("[homepage] drops_24h", negativeChangeResult.error.message);
      if (trendingVariantResult.error) logger.error("[homepage] trending", trendingVariantResult.error.message);
      if (refreshedCountResult.error) logger.error("[homepage] refreshed_count", refreshedCountResult.error.message);
      if (trackedCountResult.error) logger.error("[homepage] tracked_count", trackedCountResult.error.message);

      positiveChangeRows = (positiveChangeResult.data ?? []) as ChangeCandidateRow[];
      negativeChangeRows = (negativeChangeResult.data ?? []) as ChangeCandidateRow[];
      trendingVariants = dedupVariants((trendingVariantResult.data ?? []) as VariantRow[], CANDIDATE_FETCH_LIMIT);
      pricesRefreshedToday = refreshedCountResult.count ?? null;
      trackedCardsWithLivePrice = trackedCountResult.count ?? null;
    }

    // ── Collect all unique slugs ──────────────────────────────────────────
    const allSlugs = new Set<string>();
    for (const r of positiveChangeRows) allSlugs.add(r.canonical_slug);
    for (const r of negativeChangeRows) allSlugs.add(r.canonical_slug);
    for (const r of trendingVariants) allSlugs.add(r.canonical_slug);

    if (allSlugs.size === 0) {
      return {
        ...EMPTY,
        prices_refreshed_today: pricesRefreshedToday,
        tracked_cards_with_live_price: trackedCardsWithLivePrice,
      };
    }

    const slugArray = [...allSlugs];

    if (!overrides) {
      const client = db;
      if (!client) return EMPTY;
      const slugBatches = chunkValues(slugArray, BATCH_LOOKUP_SLUG_LIMIT);

      // ── Batch 2: card metadata + prices (with change pcts) + images ────
      const [cardResults, marketPulseResults, imageResults, sparklineResults] = await Promise.all([
        Promise.all(slugBatches.map((batch) => client
          .from("canonical_cards")
          .select("slug, canonical_name, set_name, year, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url")
          .in("slug", batch))),

        Promise.all(slugBatches.map((batch) => getCanonicalMarketPulseMap(client, batch))),

        Promise.all(slugBatches.map((batch) => client
          .from("card_printings")
          .select("canonical_slug, image_url, mirrored_image_url, mirrored_thumb_url")
          .in("canonical_slug", batch)
          .eq("language", "EN")
          .not("image_url", "is", null)
          .limit(batch.length * 3))),

        Promise.all(slugBatches.map((batch) => client
          .from("public_price_history")
          .select("canonical_slug, ts, price")
          .in("canonical_slug", batch)
          .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
          .eq("source_window", "7d")
          .order("ts", { ascending: false })
          .limit(Math.max(batch.length * 24, 120)))),
      ]);

      cardsRows = [];
      for (const result of cardResults) {
        if (result.error) {
          logger.error("[homepage] cards", result.error.message);
          continue;
        }
        cardsRows.push(...((result.data ?? []) as CardRow[]));
      }

      marketPulseMap = new Map();
      for (const pulseBatch of marketPulseResults) {
        for (const [slug, pulse] of pulseBatch.entries()) {
          if (!marketPulseMap.has(slug)) marketPulseMap.set(slug, pulse);
        }
      }

      imageRows = [];
      for (const result of imageResults) {
        if (result.error) {
          logger.error("[homepage] images", result.error.message);
          continue;
        }
        imageRows.push(...((result.data ?? []) as ImageRow[]));
      }

      sparklineRows = [];
      for (const result of sparklineResults) {
        if (result.error) {
          logger.error("[homepage] sparkline", result.error.message);
          continue;
        }
        sparklineRows.push(...((result.data ?? []) as SparklineRow[]));
      }
    }

    for (const row of [...positiveChangeRows, ...negativeChangeRows]) {
      if (marketPulseMap.has(row.canonical_slug)) continue;
      marketPulseMap.set(row.canonical_slug, buildFallbackPulseFromCandidate(row));
    }

    // ── Build lookup maps ─────────────────────────────────────────────────
    const cardMap = new Map<string, CardRow>();
    const excludedSlugSet = new Set<string>();
    for (const c of cardsRows) {
      if (!isPhysicalPokemonSet({ setName: c.set_name })) {
        excludedSlugSet.add(c.slug);
        continue;
      }
      cardMap.set(c.slug, c);
    }

    type ResolvedImage = { full: string | null; thumb: string | null };
    const imageMap = new Map<string, ResolvedImage>();
    for (const row of cardsRows) {
      if (imageMap.has(row.slug)) continue;
      const resolved = resolveCardImage(row);
      if (resolved.full || resolved.thumb) {
        imageMap.set(row.slug, resolved);
      }
    }
    for (const row of imageRows) {
      if (imageMap.has(row.canonical_slug)) continue;
      const resolved = resolveCardImage(row);
      if (resolved.full || resolved.thumb) {
        imageMap.set(row.canonical_slug, resolved);
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
        changeWindow?: HomepageSignalWindow | null;
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
      let selectedChangeWindow: HomepageSignalWindow | null = null;

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
      const salesCount30d = typeof marketPulse?.snapshotCount30d === "number" && Number.isFinite(marketPulse.snapshotCount30d)
        ? marketPulse.snapshotCount30d
        : null;
      const activeListings7d = typeof marketPulse?.activeListings7d === "number" && Number.isFinite(marketPulse.activeListings7d)
        ? marketPulse.activeListings7d
        : null;
      const updatedAt = typeof marketPulse?.marketPriceAsOf === "string" && marketPulse.marketPriceAsOf.length > 0
        ? marketPulse.marketPriceAsOf
        : null;
      return {
        slug,
        name: card?.canonical_name ?? slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        market_price: marketPulse?.marketPrice ?? overrides.fallbackPrice ?? null,
        change_pct: selectedChangePct,
        change_window: selectedChangeWindow,
        confidence_score: typeof marketPulse?.confidenceScore === "number"
          ? Math.round(marketPulse.confidenceScore)
          : null,
        low_confidence: typeof marketPulse?.lowConfidence === "boolean"
          ? marketPulse.lowConfidence
          : null,
        market_strength_score: typeof marketPulse?.marketStrengthScore === "number"
          ? Math.round(marketPulse.marketStrengthScore)
          : null,
        market_direction: marketPulse?.marketDirection ?? null,
        image_url: imageMap.get(slug)?.full ?? null,
        image_thumb_url: imageMap.get(slug)?.thumb ?? null,
        mover_tier: overrides.mover_tier ?? null,
        sparkline_7d: sparkline,
        sales_count_30d: salesCount30d,
        active_listings_7d: activeListings7d,
        updated_at: updatedAt,
      };
    }

    type PositiveMoverCollector = {
      seenSlugs: Set<string>;
      highConfidence: HomepageCard[];
      emerging: HomepageCard[];
      all: HomepageCard[];
    };

    type CardCollector = {
      seenSlugs: Set<string>;
      cards: HomepageCard[];
    };

    const createPositiveMoverCollector = (): PositiveMoverCollector => ({
      seenSlugs: new Set<string>(),
      highConfidence: [],
      emerging: [],
      all: [],
    });

    const createCardCollector = (): CardCollector => ({
      seenSlugs: new Set<string>(),
      cards: [],
    });

    const positiveRejects = { excluded: 0, noMarketPulse: 0, priceTooLow: 0, snapshotTooLow: 0, changeTooSmall: 0, staleOrLowConf: 0, noComposite: 0 };
    const negativeRejects = { excluded: 0, noMarketPulse: 0, priceTooLow: 0, snapshotTooLow: 0, staleOrLowConf: 0, noChange: 0 };

    const pushPositiveMoverIfEligible = (
      row: ChangeCandidateRow,
      collector: PositiveMoverCollector,
      preferredWindow: HomepageSignalWindow | null = null,
    ): boolean => {
      if (excludedSlugSet.has(row.canonical_slug)) { if (preferredWindow === null) positiveRejects.excluded++; return false; }
      if (collector.seenSlugs.has(row.canonical_slug)) return false;
      const marketPulse = marketPulseMap.get(row.canonical_slug);
      if (!marketPulse) { if (preferredWindow === null) positiveRejects.noMarketPulse++; return false; }
      const marketPrice = marketPulse.marketPrice ?? row.market_price ?? null;
      if (marketPrice == null) { if (preferredWindow === null) positiveRejects.priceTooLow++; return false; }
      if (SENTINEL_PRICES.has(Number(marketPrice.toFixed(2)))) { if (preferredWindow === null) positiveRejects.priceTooLow++; return false; }
      if (marketPrice < MIN_MOVER_PRICE) { if (preferredWindow === null) positiveRejects.priceTooLow++; return false; }
      const snapshotCount30d = marketPulse.snapshotCount30d ?? row.snapshot_count_30d ?? 0;
      if (snapshotCount30d < MIN_MOVER_SNAPSHOT_COUNT_30D) { if (preferredWindow === null) positiveRejects.snapshotTooLow++; return false; }
      const directionalChange = preferredWindow
        ? selectDirectionalChangeForWindow(row, "positive", preferredWindow)
        : selectDirectionalChange(row, "positive");
      const changePct = directionalChange?.value
        ?? (preferredWindow ? null : (marketPulse.changePct24h ?? marketPulse.changePct7d ?? null));
      const changeWindow = directionalChange?.window
        ?? (preferredWindow
          ? null
          : (marketPulse.changePct24h !== null ? "24H" : marketPulse.changePct7d !== null ? "7D" : null));
      if (changePct == null || changePct < MIN_MOVER_CHANGE_PCT || changeWindow === null) { if (preferredWindow === null) positiveRejects.changeTooSmall++; return false; }
      const confidenceScore = marketPulse.confidenceScore ?? row.market_confidence_score ?? 0;
      const stalenessHours = hoursSince(marketPulse.marketPriceAsOf ?? row.market_price_as_of ?? null, nowMs);
      const isStale = stalenessHours === null || stalenessHours > RECENT_MARKET_MAX_AGE_HOURS;
      const lowConfidence = marketPulse.lowConfidence === true
        || row.market_low_confidence === true
        || confidenceScore < MIN_CONFIDENCE_SCORE;
      if (isStale || lowConfidence) { if (preferredWindow === null) positiveRejects.staleOrLowConf++; return false; }
      const activeListings7d = marketPulse.activeListings7d ?? row.active_listings_7d ?? 0;
      const liquidityWeight = computeLiquidityWeight(activeListings7d);
      const compositeScore = Math.abs(changePct) * (confidenceScore / 100) * liquidityWeight;
      if (!(compositeScore > 0)) { if (preferredWindow === null) positiveRejects.noComposite++; return false; }
      const moverCard = toCard(row.canonical_slug, {
        fallbackPrice: row.market_price,
        mover_tier: activeListings7d >= HIGH_CONF_LIQUIDITY_MIN ? "hot" : "warming",
        changePct,
        changeWindow,
        preferOverrideChange: true,
        allowSparklineFallback: false,
      });
      if (activeListings7d >= HIGH_CONF_LIQUIDITY_MIN) {
        collector.highConfidence.push(moverCard);
      } else if (activeListings7d <= EMERGING_LIQUIDITY_MAX) {
        collector.emerging.push(moverCard);
      } else {
        collector.highConfidence.push(moverCard);
      }
      collector.all.push(moverCard);
      collector.seenSlugs.add(row.canonical_slug);
      return true;
    };

    const pushNegativeMoverIfEligible = (
      row: ChangeCandidateRow,
      collector: CardCollector,
      preferredWindow: HomepageSignalWindow | null = null,
    ): boolean => {
      if (excludedSlugSet.has(row.canonical_slug)) { if (preferredWindow === null) negativeRejects.excluded++; return false; }
      if (collector.seenSlugs.has(row.canonical_slug)) return false;
      const marketPulse = marketPulseMap.get(row.canonical_slug);
      if (!marketPulse) { if (preferredWindow === null) negativeRejects.noMarketPulse++; return false; }
      const price = marketPulse.marketPrice ?? row.market_price ?? null;
      if (price == null || price < MIN_MOVER_PRICE) { if (preferredWindow === null) negativeRejects.priceTooLow++; return false; }
      const snapshotCount30d = marketPulse.snapshotCount30d ?? row.snapshot_count_30d ?? 0;
      if (snapshotCount30d < MIN_MOVER_SNAPSHOT_COUNT_30D) { if (preferredWindow === null) negativeRejects.snapshotTooLow++; return false; }
      const stalenessHours = hoursSince(marketPulse.marketPriceAsOf ?? row.market_price_as_of ?? null, nowMs);
      if (stalenessHours === null || stalenessHours > RECENT_MARKET_MAX_AGE_HOURS) { if (preferredWindow === null) negativeRejects.staleOrLowConf++; return false; }
      const confidenceScore = marketPulse.confidenceScore ?? row.market_confidence_score ?? 0;
      if (marketPulse.lowConfidence === true || row.market_low_confidence === true || confidenceScore < MIN_CONFIDENCE_SCORE) {
        if (preferredWindow === null) negativeRejects.staleOrLowConf++;
        return false;
      }
      const directionalChange = preferredWindow
        ? selectDirectionalChangeForWindow(row, "negative", preferredWindow)
        : selectDirectionalChange(row, "negative");
      const changePct = directionalChange?.value
        ?? (preferredWindow ? null : (marketPulse.changePct24h ?? marketPulse.changePct7d ?? null));
      const changeWindow = directionalChange?.window
        ?? (preferredWindow
          ? null
          : (marketPulse.changePct24h !== null ? "24H" : marketPulse.changePct7d !== null ? "7D" : null));
      if (changePct == null || changePct >= 0 || changeWindow === null) { if (preferredWindow === null) negativeRejects.noChange++; return false; }
      collector.cards.push(toCard(row.canonical_slug, {
        fallbackPrice: row.market_price,
        changePct,
        changeWindow,
        preferOverrideChange: true,
        allowSparklineFallback: false,
      }));
      collector.seenSlugs.add(row.canonical_slug);
      return true;
    };

    const mixedPositiveMovers = createPositiveMoverCollector();
    const positiveMoversByWindow: Record<HomepageSignalWindow, PositiveMoverCollector> = {
      "24H": createPositiveMoverCollector(),
      "7D": createPositiveMoverCollector(),
    };

    positiveChangeRows.sort((left, right) => compareDirectionalCandidates(left, right, "positive"));
    for (const row of positiveChangeRows) {
      pushPositiveMoverIfEligible(row, mixedPositiveMovers);
      for (const window of SIGNAL_WINDOWS) {
        pushPositiveMoverIfEligible(row, positiveMoversByWindow[window], window);
      }
    }

    for (const collector of [mixedPositiveMovers, ...SIGNAL_WINDOWS.map((window) => positiveMoversByWindow[window])]) {
      collector.highConfidence.sort(compareChangeDescending);
      collector.emerging.sort(compareChangeDescending);
      collector.all.sort(compareChangeDescending);
    }

    const highConfidenceMoversOut = mixedPositiveMovers.highConfidence.slice(0, SECTION_LIMIT);
    const emergingMoversOut = mixedPositiveMovers.emerging.slice(0, SECTION_LIMIT);
    const moversOut = mixedPositiveMovers.all.slice(0, SECTION_LIMIT);

    const mixedNegativeMovers = createCardCollector();
    const negativeMoversByWindow: Record<HomepageSignalWindow, CardCollector> = {
      "24H": createCardCollector(),
      "7D": createCardCollector(),
    };

    negativeChangeRows.sort((left, right) => compareDirectionalCandidates(left, right, "negative"));
    for (const row of negativeChangeRows) {
      pushNegativeMoverIfEligible(row, mixedNegativeMovers);
      for (const window of SIGNAL_WINDOWS) {
        pushNegativeMoverIfEligible(row, negativeMoversByWindow[window], window);
      }
    }

    for (const collector of [mixedNegativeMovers, ...SIGNAL_WINDOWS.map((window) => negativeMoversByWindow[window])]) {
      collector.cards.sort(compareChangeAscending);
    }

    const losersOut = mixedNegativeMovers.cards.slice(0, SECTION_LIMIT);

    logger.info("[homepage.telemetry.filter_pipeline]", JSON.stringify({
      batch1: { positiveChangeRows: positiveChangeRows.length, negativeChangeRows: negativeChangeRows.length, trendingVariants: trendingVariants.length, allSlugs: allSlugs.size },
      jsFiltered: { movers: mixedPositiveMovers.all.length, highConfidence: mixedPositiveMovers.highConfidence.length, emerging: mixedPositiveMovers.emerging.length, losers: mixedNegativeMovers.cards.length },
      positiveRejects,
      negativeRejects,
    }));

    // ── Trending: filter to cards with real prices above MIN_PRICE ────────
    const trendingCandidatesOut: HomepageCard[] = [];
    for (const row of trendingVariants) {
      if (excludedSlugSet.has(row.canonical_slug)) continue;
      const price = marketPulseMap.get(row.canonical_slug)?.marketPrice ?? null;
      if (price == null || price < MIN_PRICE) continue;
      const trendPct = Number.isFinite(row.provider_trend_slope_7d ?? NaN)
        ? Number((row.provider_trend_slope_7d as number).toFixed(2))
        : null;
      trendingCandidatesOut.push(toCard(row.canonical_slug, {
        changePct: trendPct,
        changeWindow: trendPct !== null ? "7D" : null,
        preferOverrideChange: true,
        allowSparklineFallback: false,
      }));
    }
    trendingCandidatesOut.sort(compareChangeDescending);
    const trendingOut = trendingCandidatesOut.slice(0, SECTION_LIMIT);
    // ── Derived conviction sections (Phase 2) ────────────────────────────
    //
    // Build from the already-assembled positive + negative mover pools so
    // we cost zero extra queries. Both sections are non-windowed — they
    // answer "which cards are worth attention RIGHT NOW" rather than
    // "what moved over X hours".
    //
    // Breakouts: positive movers with hot liquidity tier AND a bullish
    // canonical market direction. This is the intersection of "price is
    // moving" and "the book agrees". Strict filter — may be empty.
    //
    // Unusual volume: cards (any direction) whose active_listings_7d is
    // notably above the pool median. These are conviction signals
    // regardless of whether the price moved yet.
    const breakoutPool = dedupeHomepageCards([
      ...mixedPositiveMovers.highConfidence,
      ...mixedPositiveMovers.all,
    ]).filter((c) => c.mover_tier === "hot" && c.market_direction === "bullish");
    breakoutPool.sort((a, b) => {
      const strengthDelta = (b.market_strength_score ?? 0) - (a.market_strength_score ?? 0);
      if (strengthDelta !== 0) return strengthDelta;
      return compareChangeDescending(a, b);
    });
    const breakoutsOut = breakoutPool.slice(0, SECTION_LIMIT);

    const unusualPool = dedupeHomepageCards([
      ...mixedPositiveMovers.all,
      ...mixedNegativeMovers.cards,
    ]).filter((c) => (c.active_listings_7d ?? 0) > 0);
    const listingCounts = unusualPool
      .map((c) => c.active_listings_7d ?? 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const listingMedian = listingCounts.length > 0
      ? listingCounts[Math.floor(listingCounts.length / 2)]
      : 0;
    // Threshold: roughly double the median, with a floor to avoid trivia.
    const unusualThreshold = Math.max(listingMedian * 2, HIGH_CONF_LIQUIDITY_MIN);
    const unusualFiltered = unusualPool.filter(
      (c) => (c.active_listings_7d ?? 0) >= unusualThreshold,
    );
    unusualFiltered.sort((a, b) => (b.active_listings_7d ?? 0) - (a.active_listings_7d ?? 0));
    const unusualVolumeOut = unusualFiltered.slice(0, SECTION_LIMIT);

    // Prefer the daily-computed top movers (generated by
    // compute_daily_top_movers RPC once per day when catalog coverage is
    // complete). If unavailable, fall back to the live per-request
    // computation below.
    let dailyMovers: DailyMoverBundle = { gainers: [], losers: [], momentum_24h: [], momentum_7d: [], computed_at_date: null };
    if (!overrides && db) {
      try {
        dailyMovers = await loadDailyTopMoversBundle(db);
      } catch (err) {
        logger.error(
          "[homepage] daily_top_movers",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const liveTopMovers24H = combineHomepageCards([
      positiveMoversByWindow["24H"].highConfidence,
      positiveMoversByWindow["24H"].all,
    ]);
    const liveTopMovers7D = combineHomepageCards([
      positiveMoversByWindow["7D"].highConfidence,
      positiveMoversByWindow["7D"].all,
      trendingCandidatesOut,
    ]);
    const liveDrops24H = negativeMoversByWindow["24H"].cards.slice(0, SECTION_LIMIT);
    const liveDrops7D = negativeMoversByWindow["7D"].cards.slice(0, SECTION_LIMIT);

    // Split the daily list by change_window so the UI's 24H/7D pills still
    // work. If one window is empty in the daily list, fall back to the other.
    const dailyGainers24H = dailyMovers.gainers.filter((c) => c.change_window === "24H");
    const dailyGainers7D = dailyMovers.gainers.filter((c) => c.change_window === "7D");
    const dailyLosers24H = dailyMovers.losers.filter((c) => c.change_window === "24H");
    const dailyLosers7D = dailyMovers.losers.filter((c) => c.change_window === "7D");

    const signalBoard = {
      top_movers: {
        "24H": dailyGainers24H.length > 0
          ? dailyGainers24H.slice(0, SECTION_LIMIT)
          : (dailyMovers.gainers.length > 0
            ? dailyMovers.gainers.slice(0, SECTION_LIMIT)
            : liveTopMovers24H),
        "7D": dailyGainers7D.length > 0
          ? dailyGainers7D.slice(0, SECTION_LIMIT)
          : (dailyMovers.gainers.length > 0
            ? dailyMovers.gainers.slice(0, SECTION_LIMIT)
            : liveTopMovers7D),
      },
      biggest_drops: {
        "24H": dailyLosers24H.length > 0
          ? dailyLosers24H.slice(0, SECTION_LIMIT)
          : (dailyMovers.losers.length > 0
            ? dailyMovers.losers.slice(0, SECTION_LIMIT)
            : liveDrops24H),
        "7D": dailyLosers7D.length > 0
          ? dailyLosers7D.slice(0, SECTION_LIMIT)
          : (dailyMovers.losers.length > 0
            ? dailyMovers.losers.slice(0, SECTION_LIMIT)
            : liveDrops7D),
      },
      momentum: {
        // Prefer the daily-computed momentum rails so the iOS For You
        // rail (which prefers momentum over top_movers) doesn't flip
        // every app open. Fall back to live compute if today's daily
        // list is missing.
        "24H": dailyMovers.momentum_24h.length > 0
          ? dailyMovers.momentum_24h.slice(0, SECTION_LIMIT)
          : combineHomepageCards([
              positiveMoversByWindow["24H"].emerging,
              positiveMoversByWindow["24H"].highConfidence,
              positiveMoversByWindow["24H"].all,
            ]),
        "7D": dailyMovers.momentum_7d.length > 0
          ? dailyMovers.momentum_7d.slice(0, SECTION_LIMIT)
          : combineHomepageCards([
              trendingCandidatesOut,
              positiveMoversByWindow["7D"].all,
            ]),
      },
      unusual_volume: unusualVolumeOut,
      breakouts: breakoutsOut,
    } satisfies HomepageSignalBoardData;

    // ── Derive as_of ──────────────────────────────────────────────────────
    const marketTimestamps = [...marketPulseMap.values()]
      .map((pulse) => pulse.marketPriceAsOf)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const fallbackTimestamps = trendingVariants
      .map((row) => row.updated_at)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const as_of = marketTimestamps.sort().reverse()[0] ?? fallbackTimestamps.sort().reverse()[0] ?? null;

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
      signal_board: signalBoard,
      as_of,
      prices_refreshed_today: pricesRefreshedToday,
      tracked_cards_with_live_price: trackedCardsWithLivePrice,
    };

  } catch (err) {
    logger.error("[homepage] getHomepageData failed:", err);
    return EMPTY;
  }
}
