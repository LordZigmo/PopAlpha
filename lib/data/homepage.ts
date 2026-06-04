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
  type MarketBlendPolicy,
  type MarketPriceDisplayState,
  type MarketProvenance,
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
  card_number: string | null;
  display_card_number?: string | null;
  market_price: number | null;
  market_price_display_state: MarketPriceDisplayState | null;
  recent_market_signal_usd: number | null;
  recent_market_signal_as_of: string | null;
  recent_market_signal_delta_pct: number | null;
  recent_market_signal_direction: "HIGHER" | "LOWER" | null;
  price_identity_label?: string | null;
  price_finish_label?: string | null;
  price_finish?: string | null;
  price_edition?: string | null;
  price_stamp?: string | null;
  price_has_multiple_finishes?: boolean | null;
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
  // JP-native price sources surfaced on JP-rail tiles so the user
  // sees real JP-market data instead of the default USD market anchor
  // when we have it. Both are nullable — most non-JP cards will be
  // null here. Tile rendering uses lib/pricing/jp-price-source.ts
  // to confidence-pick between them.
  yahoo_jp_price: number | null;
  // Native JPY value (Yahoo! JP captures price_jpy directly at observation
  // time; this is the seller's listed yen price, not USD * current FX).
  // Surfaced on JP-source tiles as "¥X,XXX ($X)" so the user reads
  // a JP price as a JP price, not as our USD reflection.
  yahoo_jp_price_jpy: number | null;
  yahoo_jp_sample_count: number | null;
  snkrdunk_price: number | null;
  // FX-derived JPY (price_usd / JPY_TO_USD_RATE at observation time).
  // Snkrdunk's English API returns USD only, so this is an
  // approximation — not the seller's listed yen value. Added 2026-05-16
  // (Phase C-1b) so Snkrdunk-sourced tiles render "¥X,XXX ($X)" matching
  // the Yahoo! JP path. Stored as a column on snkrdunk_card_prices and
  // exposed by the public_card_metrics view.
  snkrdunk_price_jpy: number | null;
  snkrdunk_sample_count: number | null;
};

export type HomepageWindowedCards = Record<HomepageSignalWindow, HomepageCard[]>;

export type HomepageSignalBoardData = {
  market_watch: HomepageCard[];
  top_movers: HomepageWindowedCards;
  biggest_drops: HomepageWindowedCards;
  momentum: HomepageWindowedCards;
  // Phase 2: dedicated conviction signals (non-windowed — these are cached,
  // not time-sliced like top_movers/biggest_drops).
  unusual_volume: HomepageCard[];
  breakouts: HomepageCard[];
  // Mid tier ($8 .. premium_min_price): gainers from the $8-$50 band added
  // 2026-05-04 to give discoverable signal in the band most collectors
  // shop. Mid-tier loser/momentum rail kinds also exist in
  // daily_top_movers but aren't surfaced in the signal board yet.
  mid_movers: HomepageCard[];
  // Budget tier ($1 .. mid_min_price): gainers from cards below the mid
  // price floor. Single rail, no window split.
  budget_movers: HomepageCard[];
  // JP catalog rails (canonical_cards.language = 'JP'). Mirror the EN
  // structure 1:1 so the JP market view feels as busy as EN. Sourced
  // from public_card_metrics' public change_pct columns filtered to
  // language='JP'; once the JP-native delta pipeline (jp_card_metrics)
  // ships these loaders swap to it without changing the wire shape.
  japanese_top_movers: HomepageWindowedCards;
  japanese_biggest_drops: HomepageWindowedCards;
  japanese_momentum: HomepageWindowedCards;
  japanese_mid_movers: HomepageCard[];
  japanese_budget_movers: HomepageCard[];
  // Discovery rail — sorted by snapshot freshness so the JP view always
  // shows at least one rail of recently-priced JP cards even when the
  // mover gates yield nothing.
  japanese: HomepageCard[];
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
  market_price_display_state?: MarketPriceDisplayState | null;
  recent_market_signal_usd?: number | null;
  recent_market_signal_as_of?: string | null;
  recent_market_signal_delta_pct?: number | null;
  recent_market_signal_direction?: "HIGHER" | "LOWER" | null;
  snapshot_count_30d: number | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
  market_confidence_score: number | null;
  market_low_confidence: boolean | null;
  active_listings_7d: number | null;
  market_blend_policy?: MarketBlendPolicy | null;
  market_provenance?: MarketProvenance | null;
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
  card_number: string | null;
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

type CardDisplayIdentityRow = {
  slug: string;
  display_card_number: string | null;
  price_finish: string | null;
  price_edition: string | null;
  price_stamp: string | null;
  has_multiple_finishes: boolean | null;
};

type HomepageLogger = Pick<Console, "error" | "info">;

type JpPriceCoverageRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  primary_image_url?: string | null;
  mirrored_primary_image_url?: string | null;
  mirrored_primary_thumb_url?: string | null;
  market_price: number | null;
  market_price_as_of: string | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
  active_listings_7d: number | null;
  market_confidence_score: number | null;
  snapshot_count_30d: number | null;
  market_low_confidence: boolean | null;
  yahoo_jp_price: number | null;
  yahoo_jp_price_jpy: number | null;
  yahoo_jp_sample_count: number | null;
  snkrdunk_price: number | null;
  snkrdunk_price_jpy: number | null;
  snkrdunk_sample_count: number | null;
  display_price_source?: string | null;
  display_price_usd: number | null;
  display_price_as_of: string | null;
  jp_latest_price: number | null;
  jp_latest_price_as_of: string | null;
};

type HomepageDataOverrides = {
  positiveChangeRows?: ChangeCandidateRow[];
  negativeChangeRows?: ChangeCandidateRow[];
  marketWatchRows?: ChangeCandidateRow[];
  trendingVariants?: VariantRow[];
  cards?: CardRow[];
  marketPulseMap?: Map<string, CanonicalMarketPulse>;
  images?: ImageRow[];
  sparklineRows?: SparklineRow[];
  displayIdentities?: CardDisplayIdentityRow[];
  dailyMovers?: DailyMoverBundle;
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
const MARKET_WATCH_LIMIT = 20;
// The JP discovery rail ("Trending") is the ONLY populated JP home rail until
// the change_pct-gated JP movers rails light up (~mid-June). EN looks full via
// ~8 small rails of SECTION_LIMIT each; JP currently has just this one, so a
// 5-card cap makes the JP home a stub. Give the sole JP rail a generous limit.
// (loadJapaneseSignalRails stays at SECTION_LIMIT — those follow the EN
// multi-rail sizing once they have data.)
const JAPANESE_RAIL_LIMIT = 40;
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
const MARKET_WATCH_CANDIDATE_FETCH_LIMIT = 160;
const BATCH_LOOKUP_SLUG_LIMIT = 40;
const SENTINEL_PRICES = new Set([23456.78]);
const MIN_MOVER_CHANGE_PCT = 2.5;
const MIN_CONFIDENCE_SCORE = 45;
const HIGH_CONF_LIQUIDITY_MIN = 6;
const EMERGING_LIQUIDITY_MAX = 5;
const MIN_PUBLIC_MOVER_HISTORY_POINTS = 2;
// Was 1. The strict price-trust coverage gate (eligible-pool threshold 25)
// can trip on consecutive days, writing zero daily_top_movers rows; a 1-day
// fallback then empties the signal-board rails entirely (observed 05-27/05-29
// 2026). 3 days lets the last good bundle bridge short gate-trip gaps —
// freshness-degraded but present beats empty. The underlying gate sparsity is
// mitigated product-side by the Market Watch rail.
const MAX_DAILY_MOVER_AGE_DAYS = 3;

function createEmptyWindowedCards(): HomepageWindowedCards {
  return { "24H": [], "7D": [] };
}

function computedDateAgeDays(value: string, nowMs: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const computedMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(computedMs)) return null;
  const now = new Date(nowMs);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((todayMs - computedMs) / (24 * 60 * 60 * 1000)));
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
  card_number: string | null;
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

type DailyMoverKind =
  | "gainer" | "loser" | "momentum_24h" | "momentum_7d" | "budget_gainer"
  | "mid_gainer" | "mid_loser" | "mid_momentum_24h" | "mid_momentum_7d";

type DailyMoverBundle = {
  gainers: HomepageCard[];
  losers: HomepageCard[];
  momentum_24h: HomepageCard[];
  momentum_7d: HomepageCard[];
  budget_gainers: HomepageCard[];
  mid_gainers: HomepageCard[];
  mid_losers: HomepageCard[];
  mid_momentum_24h: HomepageCard[];
  mid_momentum_7d: HomepageCard[];
  computed_at_date: string | null;
};

const EMPTY_DAILY_MOVER_BUNDLE: DailyMoverBundle = {
  gainers: [], losers: [], momentum_24h: [], momentum_7d: [], budget_gainers: [],
  mid_gainers: [], mid_losers: [], mid_momentum_24h: [], mid_momentum_7d: [],
  computed_at_date: null,
};

async function loadDailyTopMoversBundle(
  client: NonNullable<ReturnType<typeof dbPublic>>,
  nowMs = Date.now(),
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
    return { ...EMPTY_DAILY_MOVER_BUNDLE };
  }

  const computedDate = latestDateRow.computed_at_date;
  const ageDays = computedDateAgeDays(computedDate, nowMs);
  if (ageDays === null || ageDays > MAX_DAILY_MOVER_AGE_DAYS) {
    return { ...EMPTY_DAILY_MOVER_BUNDLE, computed_at_date: computedDate };
  }

  const { data, error } = await client
    .from("daily_top_movers")
    .select(
      "rank, kind, canonical_slug, change_pct, change_window, market_price, market_price_as_of, set_name, active_listings_7d, confidence_score, canonical_cards(canonical_name, year, card_number, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url)",
    )
    .eq("computed_at_date", computedDate)
    .order("kind", { ascending: true })
    .order("rank", { ascending: true });

  if (error || !data) {
    return { ...EMPTY_DAILY_MOVER_BUNDLE, computed_at_date: computedDate };
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
      card_number: canonicalCard?.card_number ?? null,
      market_price: row.market_price,
      market_price_display_state: null,
      recent_market_signal_usd: null,
      recent_market_signal_as_of: null,
      recent_market_signal_delta_pct: null,
      recent_market_signal_direction: null,
      change_pct: row.change_pct,
      change_window: row.change_window,
      confidence_score: row.confidence_score,
      low_confidence: false,
      market_strength_score: null,
      market_direction: null,
      mover_tier:
        row.kind === "loser" || row.kind === "mid_loser"
          ? (highConfidence ? "cooling" : "cold")
          // Gainers and momentum lean upward; warmth tracks liquidity.
          : (highConfidence ? "hot" : "warming"),
      image_url: image.full,
      image_thumb_url: image.thumb,
      sparkline_7d: [],
      sales_count_30d: null,
      active_listings_7d: row.active_listings_7d,
      updated_at: row.market_price_as_of,
      // Signal-board rails (top_movers / biggest_drops / momentum)
      // source from daily_top_movers which doesn't carry JP-source
      // prices. Most signal-board cards aren't JP anyway. Default
      // null — tile-mini falls back to market_price.
      yahoo_jp_price: null,
      yahoo_jp_price_jpy: null,
      yahoo_jp_sample_count: null,
      snkrdunk_price: null,
      snkrdunk_price_jpy: null,
      snkrdunk_sample_count: null,
    };
  };

  const gainers: HomepageCard[] = [];
  const losers: HomepageCard[] = [];
  const momentum_24h: HomepageCard[] = [];
  const momentum_7d: HomepageCard[] = [];
  const budget_gainers: HomepageCard[] = [];
  const mid_gainers: HomepageCard[] = [];
  const mid_losers: HomepageCard[] = [];
  const mid_momentum_24h: HomepageCard[] = [];
  const mid_momentum_7d: HomepageCard[] = [];
  for (const raw of (data ?? []) as unknown as Array<DailyMoverRow & { kind: DailyMoverKind }>) {
    const card = toCard(raw);
    switch (raw.kind) {
      case "gainer": gainers.push(card); break;
      case "loser": losers.push(card); break;
      case "momentum_24h": momentum_24h.push(card); break;
      case "momentum_7d": momentum_7d.push(card); break;
      case "budget_gainer": budget_gainers.push(card); break;
      case "mid_gainer": mid_gainers.push(card); break;
      case "mid_loser": mid_losers.push(card); break;
      case "mid_momentum_24h": mid_momentum_24h.push(card); break;
      case "mid_momentum_7d": mid_momentum_7d.push(card); break;
    }
  }

  return {
    gainers, losers, momentum_24h, momentum_7d, budget_gainers,
    mid_gainers, mid_losers, mid_momentum_24h, mid_momentum_7d,
    computed_at_date: computedDate,
  };
}

/**
 * Discovery rail for the Japanese catalog. Sorted by snapshot freshness
 * so the rail leads with cards we have current pricing on. Doesn't try
 * to compute change_pct/momentum because the JP catalog is still small
 * and most cards lack the 30+ day snapshot history needed for those
 * signals. Once the JP catalog grows past ~500 cards we can promote
 * this to a proper japanese_gainer/japanese_momentum kind on
 * compute_daily_top_movers and reuse the same UI rail.
 */
async function loadJapaneseRail(
  client: NonNullable<ReturnType<typeof dbPublic>>,
  limit: number,
  // Optional price-tier filter (on display_price_usd) so the same loader powers
  // the all-prices "Trending" rail and the Mid ($8-50) / Budget (<$8) discovery
  // rails. Tier membership is approximate at the boundary since the displayed
  // price is jp_latest_price ?? display_price_usd, but close enough for a rail.
  opts: { minPrice?: number; maxPrice?: number } = {},
): Promise<HomepageCard[]> {
  let query = client
    .from("public_jp_price_coverage")
    .select(
      "canonical_slug, canonical_name, set_name, year, card_number, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url, market_price, market_price_as_of, change_pct_24h, change_pct_7d, active_listings_7d, market_confidence_score, snapshot_count_30d, market_low_confidence, yahoo_jp_price, yahoo_jp_price_jpy, yahoo_jp_sample_count, snkrdunk_price, snkrdunk_price_jpy, snkrdunk_sample_count, display_price_source, display_price_usd, display_price_as_of, jp_latest_price, jp_latest_price_as_of",
    )
    .eq("covered_by_price", true)
    .in("display_price_source", ["yahoo_jp", "snkrdunk"]);
  if (opts.minPrice != null) query = query.gte("display_price_usd", opts.minPrice);
  if (opts.maxPrice != null) query = query.lt("display_price_usd", opts.maxPrice);
  const { data, error } = await query
    .order("display_price_as_of", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error || !data) return [];
  const rows = data as unknown as JpPriceCoverageRow[];
  return rows
    .map<HomepageCard | null>((row) => {
      // Prefer the blended freshest JP price (jp_latest_price) over the
      // source-pick display price, which can be a stale Yahoo observation
      // (e.g. $0.20 when Snkrdunk shows $31). Falls back when no fresh point.
      const jpDisplayPrice = row.jp_latest_price ?? row.display_price_usd;
      if (jpDisplayPrice == null || jpDisplayPrice <= 0) return null;
      if (!hasJpNativeHomepagePriceSource(row.display_price_source)) return null;
      const changePct = row.change_pct_24h ?? row.change_pct_7d ?? null;
      const changeWindow: "24H" | "7D" = row.change_pct_24h != null ? "24H" : "7D";
      const image = resolveCardImage({
        primary_image_url: row.primary_image_url ?? null,
        mirrored_primary_image_url: row.mirrored_primary_image_url ?? null,
        mirrored_primary_thumb_url: row.mirrored_primary_thumb_url ?? null,
      });
      const highConfidence = (row.active_listings_7d ?? 0) >= HIGH_CONF_LIQUIDITY_MIN;
      return {
        slug: row.canonical_slug,
        name: row.canonical_name,
        set_name: row.set_name ?? null,
        year: row.year ?? null,
        card_number: row.card_number ?? null,
        market_price: jpDisplayPrice,
        market_price_display_state: null,
        recent_market_signal_usd: null,
        recent_market_signal_as_of: null,
        recent_market_signal_delta_pct: null,
        recent_market_signal_direction: null,
        change_pct: changePct,
        change_window: changeWindow,
        confidence_score: row.market_confidence_score ?? null,
        low_confidence: Boolean(row.market_low_confidence),
        market_strength_score: null,
        market_direction: null,
        mover_tier: highConfidence ? "hot" : "warming",
        image_url: image.full,
        image_thumb_url: image.thumb,
        sparkline_7d: [],
        sales_count_30d: row.snapshot_count_30d ?? null,
        active_listings_7d: row.active_listings_7d ?? null,
        updated_at: (row.jp_latest_price != null ? row.jp_latest_price_as_of : null) ?? row.display_price_as_of ?? null,
        yahoo_jp_price: row.yahoo_jp_price,
        yahoo_jp_price_jpy: row.yahoo_jp_price_jpy,
        yahoo_jp_sample_count: row.yahoo_jp_sample_count,
        snkrdunk_price: row.snkrdunk_price,
        snkrdunk_price_jpy: row.snkrdunk_price_jpy,
        snkrdunk_sample_count: row.snkrdunk_sample_count,
      };
    })
    .filter((card): card is HomepageCard => card !== null);
}

/**
 * JP-market signal-board rails (top movers, biggest drops, momentum, mid,
 * budget). Mirrors the EN signal-board structure so JP feels as busy as EN.
 *
 * Implementation note: one query fetches every JP card with usable metrics,
 * then we sort/filter in memory to produce the five rails. The JP catalog
 * is small enough (~3k cards) that this beats five round-trips. Once the
 * JP-native delta pipeline ships (jp_card_metrics), these rails will read
 * from `daily_top_movers` filtered by jp_* kinds instead — same wire shape,
 * so the homepage component is unchanged.
 *
 * Gates vs EN: keep market_confidence_score / low_confidence quality
 * floors. Drop snapshot_count_30d gate (EN tuning, kills JP cards whose
 * public market history is shallow). Use a 7d freshness window since JP
 * cards are less likely to have 24h snapshots than EN.
 */
type JpRailBundle = {
  topMovers: HomepageWindowedCards;
  biggestDrops: HomepageWindowedCards;
  momentum: HomepageWindowedCards;
  midMovers: HomepageCard[];
  budgetMovers: HomepageCard[];
};

const JP_PREMIUM_MIN_PRICE = 50;
// JP rail thresholds intentionally looser than EN's MIN_MOVER_CHANGE_PCT
// (2.5%). The EN floor noise-filters across ~25k priced rows; the JP
// catalog has a much smaller denominator (~3-5k priced rows), so few
// JP cards clear ±2.5% in a 24h/7d window — the pullbacks rail in
// particular would render empty on most days. 1% lets enough JP
// candidates through to feel busy without surfacing flat noise.
const JP_MIN_MOVER_CHANGE_PCT = 1;
const JP_MID_MIN_PRICE = 8;
const JP_BUDGET_MIN_PRICE = 1;
const JP_FRESHNESS_MAX_AGE_HOURS = 7 * 24;
const JP_MAX_CHANGE_PCT = 75;

async function loadJapaneseSignalRails(
  client: NonNullable<ReturnType<typeof dbPublic>>,
  limit: number,
): Promise<JpRailBundle> {
  const empty: JpRailBundle = {
    topMovers: createEmptyWindowedCards(),
    biggestDrops: createEmptyWindowedCards(),
    momentum: createEmptyWindowedCards(),
    midMovers: [],
    budgetMovers: [],
  };

  // Fetch every JP card with trusted RAW price coverage — paginate via .range()
  // because PostgREST caps each response at 1000 rows. The JP catalog's
  // priced cohort is climbing (~3-5k today, growing as Snkrdunk and
  // Yahoo! JP matches expand) and the in-memory ranking below needs to
  // see every candidate, otherwise a top mover further down the page
  // can never reach the rail. Same pattern getJapaneseCatalogState uses
  // in lib/data/tier-summary.ts. Hard cap at 20k as a safety valve so a
  // pipeline bug can never balloon this loader unbounded.
  const PAGE_SIZE = 1000;
  const MAX_ROWS = 20_000;
  const rows: JpPriceCoverageRow[] = [];
  let from = 0;
  while (rows.length < MAX_ROWS) {
    const { data, error } = await client
      .from("public_jp_price_coverage")
      .select(
        "canonical_slug, canonical_name, set_name, year, card_number, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url, market_price, market_price_as_of, change_pct_24h, change_pct_7d, active_listings_7d, market_confidence_score, snapshot_count_30d, market_low_confidence, yahoo_jp_price, yahoo_jp_price_jpy, yahoo_jp_sample_count, snkrdunk_price, snkrdunk_price_jpy, snkrdunk_sample_count, display_price_source, display_price_usd, display_price_as_of, jp_latest_price, jp_latest_price_as_of",
      )
      .eq("covered_by_price", true)
      .in("display_price_source", ["yahoo_jp", "snkrdunk"])
      .gte("display_price_usd", JP_BUDGET_MIN_PRICE)
      .gte("market_confidence_score", MIN_CONFIDENCE_SCORE)
      // Deterministic ordering required for stable .range() pagination:
      // without an explicit order, PostgreSQL can return rows in any
      // sequence across requests, so later pages would skip or
      // duplicate candidates.
      .order("canonical_slug", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data) {
      // First-page error → return empty so the JP rails just render
      // their empty states. Mid-walk error → break and rank from the
      // partial set rather than throw away the work we already did.
      if (rows.length === 0) return empty;
      break;
    }
    const page = data as unknown as JpPriceCoverageRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // ── Build per-window candidate maps. Each window holds {card, changePct}.
  //   We materialize per (slug, window) so a card with both change_pct_24h
  //   and change_pct_7d can appear in both windows ranked by that window's
  //   value — same shape as the EN rails.
  type Candidate = {
    card: HomepageCard;
    changePct: number;
    marketPrice: number;
  };
  const candidates24h: Candidate[] = [];
  const candidates7d: Candidate[] = [];
  const nowMs = Date.now();

  for (const row of rows) {
    // Prefer the blended freshest JP price (+ as-of) over the source-pick
    // display price/as-of, which can be a stale Yahoo observation. Budget
    // membership, the freshness gate, and the displayed price all use this one
    // value so the rail can't filter on one price and show another.
    const jpDisplayPrice = row.jp_latest_price ?? row.display_price_usd;
    const jpDisplayAsOf = (row.jp_latest_price != null ? row.jp_latest_price_as_of : null) ?? row.display_price_as_of;
    if (jpDisplayPrice == null || jpDisplayPrice < JP_BUDGET_MIN_PRICE) continue;
    if (!hasJpNativeHomepagePriceSource(row.display_price_source)) continue;
    if (row.market_low_confidence === true) continue;

    const asOfMs = jpDisplayAsOf ? Date.parse(jpDisplayAsOf) : NaN;
    if (!Number.isFinite(asOfMs)) continue;
    const ageHours = (nowMs - asOfMs) / (60 * 60 * 1000);
    if (ageHours > JP_FRESHNESS_MAX_AGE_HOURS) continue;

    const image = resolveCardImage({
      primary_image_url: row.primary_image_url ?? null,
      mirrored_primary_image_url: row.mirrored_primary_image_url ?? null,
      mirrored_primary_thumb_url: row.mirrored_primary_thumb_url ?? null,
    });
    const highConfidence = (row.active_listings_7d ?? 0) >= HIGH_CONF_LIQUIDITY_MIN;
    const baseCard = (changePct: number, window: HomepageSignalWindow): HomepageCard => ({
      slug: row.canonical_slug,
      name: row.canonical_name,
      set_name: row.set_name ?? null,
      year: row.year ?? null,
      card_number: row.card_number ?? null,
      market_price: jpDisplayPrice,
      market_price_display_state: null,
      recent_market_signal_usd: null,
      recent_market_signal_as_of: null,
      recent_market_signal_delta_pct: null,
      recent_market_signal_direction: null,
      change_pct: changePct,
      change_window: window,
      confidence_score: row.market_confidence_score ?? null,
      low_confidence: Boolean(row.market_low_confidence),
      market_strength_score: null,
      market_direction: null,
      mover_tier: highConfidence ? "hot" : "warming",
      image_url: image.full,
      image_thumb_url: image.thumb,
      sparkline_7d: [],
      sales_count_30d: row.snapshot_count_30d ?? null,
      active_listings_7d: row.active_listings_7d ?? null,
      updated_at: jpDisplayAsOf ?? null,
      yahoo_jp_price: row.yahoo_jp_price,
      yahoo_jp_price_jpy: row.yahoo_jp_price_jpy,
      yahoo_jp_sample_count: row.yahoo_jp_sample_count,
      snkrdunk_price: row.snkrdunk_price,
      snkrdunk_price_jpy: row.snkrdunk_price_jpy,
      snkrdunk_sample_count: row.snkrdunk_sample_count,
    });

    if (row.change_pct_24h != null && Math.abs(row.change_pct_24h) <= JP_MAX_CHANGE_PCT) {
      candidates24h.push({
        card: baseCard(row.change_pct_24h, "24H"),
        changePct: row.change_pct_24h,
        marketPrice: jpDisplayPrice,
      });
    }
    if (row.change_pct_7d != null && Math.abs(row.change_pct_7d) <= JP_MAX_CHANGE_PCT) {
      candidates7d.push({
        card: baseCard(row.change_pct_7d, "7D"),
        changePct: row.change_pct_7d,
        marketPrice: jpDisplayPrice,
      });
    }
  }

  // Set-diversity guard: cap each set to 2 hits per rail. Same rule the
  // EN compute_daily_top_movers function enforces so a single hot set
  // doesn't crowd the entire rail.
  const SET_CAP = 2;
  const pickWithSetCap = (
    candidates: Candidate[],
    predicate: (c: Candidate) => boolean,
    sort: (a: Candidate, b: Candidate) => number,
  ): HomepageCard[] => {
    const sorted = candidates.filter(predicate).sort(sort);
    const setCounts = new Map<string, number>();
    const picked: HomepageCard[] = [];
    for (const c of sorted) {
      const key = c.card.set_name?.toLowerCase() ?? "__unknown_set__";
      const taken = setCounts.get(key) ?? 0;
      if (taken >= SET_CAP) continue;
      setCounts.set(key, taken + 1);
      picked.push(c.card);
      if (picked.length >= limit) break;
    }
    return picked;
  };

  const byChangeDesc = (a: Candidate, b: Candidate) => b.changePct - a.changePct;
  const byChangeAsc = (a: Candidate, b: Candidate) => a.changePct - b.changePct;

  const topMovers: HomepageWindowedCards = {
    "24H": pickWithSetCap(candidates24h, (c) => c.changePct >= JP_MIN_MOVER_CHANGE_PCT, byChangeDesc),
    "7D": pickWithSetCap(candidates7d, (c) => c.changePct >= JP_MIN_MOVER_CHANGE_PCT, byChangeDesc),
  };
  const biggestDrops: HomepageWindowedCards = {
    "24H": pickWithSetCap(candidates24h, (c) => c.changePct <= -JP_MIN_MOVER_CHANGE_PCT, byChangeAsc),
    "7D": pickWithSetCap(candidates7d, (c) => c.changePct <= -JP_MIN_MOVER_CHANGE_PCT, byChangeAsc),
  };
  const momentum: HomepageWindowedCards = {
    "24H": pickWithSetCap(
      candidates24h,
      (c) => c.changePct > 0 && c.marketPrice >= JP_PREMIUM_MIN_PRICE,
      byChangeDesc,
    ),
    "7D": pickWithSetCap(
      candidates7d,
      (c) => c.changePct > 0 && c.marketPrice >= JP_PREMIUM_MIN_PRICE,
      byChangeDesc,
    ),
  };

  // Mid + budget rails take the best 24H signal when present, falling
  // back to 7D so a card whose 24H is null still surfaces as a mid/budget
  // gainer. Build a per-slug "best window" set and rank from there.
  const bestByslug = new Map<string, Candidate>();
  for (const c of candidates24h) bestByslug.set(c.card.slug, c);
  for (const c of candidates7d) {
    if (!bestByslug.has(c.card.slug)) bestByslug.set(c.card.slug, c);
  }
  const bestCandidates = [...bestByslug.values()];

  const midMovers = pickWithSetCap(
    bestCandidates,
    (c) =>
      c.changePct >= JP_MIN_MOVER_CHANGE_PCT
      && c.marketPrice >= JP_MID_MIN_PRICE
      && c.marketPrice < JP_PREMIUM_MIN_PRICE,
    byChangeDesc,
  );
  const budgetMovers = pickWithSetCap(
    bestCandidates,
    (c) =>
      c.changePct >= JP_MIN_MOVER_CHANGE_PCT
      && c.marketPrice >= JP_BUDGET_MIN_PRICE
      && c.marketPrice < JP_MID_MIN_PRICE,
    byChangeDesc,
  );

  return { topMovers, biggestDrops, momentum, midMovers, budgetMovers };
}

function createEmptySignalBoard(): HomepageSignalBoardData {
  return {
    market_watch: [],
    top_movers: createEmptyWindowedCards(),
    biggest_drops: createEmptyWindowedCards(),
    momentum: createEmptyWindowedCards(),
    unusual_volume: [],
    breakouts: [],
    mid_movers: [],
    budget_movers: [],
    japanese_top_movers: createEmptyWindowedCards(),
    japanese_biggest_drops: createEmptyWindowedCards(),
    japanese_momentum: createEmptyWindowedCards(),
    japanese_mid_movers: [],
    japanese_budget_movers: [],
    japanese: [],
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

function collectDailyMoverBundleCards(bundle: DailyMoverBundle): HomepageCard[] {
  return [
    ...bundle.gainers,
    ...bundle.losers,
    ...bundle.momentum_24h,
    ...bundle.momentum_7d,
    ...bundle.budget_gainers,
    ...bundle.mid_gainers,
    ...bundle.mid_losers,
    ...bundle.mid_momentum_24h,
    ...bundle.mid_momentum_7d,
  ];
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

function toFiniteCount(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    market_price_display_state: row.market_price_display_state ?? null,
    recent_market_signal_usd: row.recent_market_signal_usd ?? null,
    recent_market_signal_as_of: row.recent_market_signal_as_of ?? null,
    recent_market_signal_delta_pct: row.recent_market_signal_delta_pct ?? null,
    recent_market_signal_direction: row.recent_market_signal_direction ?? null,
    active_listings_7d: row.active_listings_7d,
    snapshot_count_30d: row.snapshot_count_30d,
    market_confidence_score: row.market_confidence_score,
    market_low_confidence: row.market_low_confidence,
    market_blend_policy: row.market_blend_policy ?? null,
    market_provenance: row.market_provenance,
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

function normalizeDisplayText(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function homepageFinishLabel(value: string | null | undefined): string | null {
  switch (value) {
    case "NON_HOLO": return "Regular";
    case "HOLO": return "Holo";
    case "REVERSE_HOLO": return "Reverse Holo";
    case "ALT_HOLO": return "Alt Art";
    default: return null;
  }
}

function homepageStampLabel(value: string | null | undefined): string | null {
  const stamp = normalizeDisplayText(value);
  if (!stamp) return null;
  switch (stamp.toUpperCase()) {
    case "POKE_BALL_PATTERN": return "Poke Ball";
    case "MASTER_BALL_PATTERN": return "Master Ball";
    case "SHADOWLESS": return "Shadowless";
    default:
      return stamp
        .split("_")
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
        .join(" ");
  }
}

function priceIdentityLabels(identity: CardDisplayIdentityRow | undefined): {
  priceIdentityLabel: string | null;
  priceFinishLabel: string | null;
} {
  if (!identity) {
    return { priceIdentityLabel: "Raw market", priceFinishLabel: null };
  }

  const finish = homepageFinishLabel(identity.price_finish);
  const edition = identity.price_edition === "FIRST_EDITION" ? "1st Ed" : null;
  const stamp = homepageStampLabel(identity.price_stamp);
  const finishParts = [finish, edition, stamp].filter((part): part is string => Boolean(part));
  const finishLabel = finishParts.join(" · ") || (identity.has_multiple_finishes ? "finish varies" : null);
  return {
    priceIdentityLabel: finishLabel ? `Raw market · ${finishLabel}` : "Raw market",
    priceFinishLabel: finishLabel,
  };
}

function applyDisplayIdentityToCard(
  card: HomepageCard,
  identityBySlug: Map<string, CardDisplayIdentityRow>,
): HomepageCard {
  const identity = identityBySlug.get(card.slug);
  const { priceIdentityLabel, priceFinishLabel } = priceIdentityLabels(identity);
  return {
    ...card,
    display_card_number:
      normalizeDisplayText(identity?.display_card_number)
      ?? normalizeDisplayText(card.display_card_number)
      ?? normalizeDisplayText(card.card_number),
    price_identity_label: priceIdentityLabel,
    price_finish_label: priceFinishLabel,
    price_finish: identity?.price_finish ?? null,
    price_edition: identity?.price_edition ?? null,
    price_stamp: identity?.price_stamp ?? null,
    price_has_multiple_finishes: identity?.has_multiple_finishes ?? null,
  };
}

function applyDisplayIdentityToWindowedCards(
  cards: HomepageWindowedCards,
  identityBySlug: Map<string, CardDisplayIdentityRow>,
): HomepageWindowedCards {
  return {
    "24H": cards["24H"].map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    "7D": cards["7D"].map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
  };
}

function collectHomepageDataSlugs(data: HomepageData): string[] {
  const slugs = new Set<string>();
  const addCards = (cards: HomepageCard[]) => {
    for (const card of cards) slugs.add(card.slug);
  };
  const addWindowed = (cards: HomepageWindowedCards) => {
    addCards(cards["24H"]);
    addCards(cards["7D"]);
  };

  addCards(data.movers);
  addCards(data.high_confidence_movers);
  addCards(data.emerging_movers);
  addCards(data.losers);
  addCards(data.trending);
  addCards(data.signal_board.market_watch);
  addWindowed(data.signal_board.top_movers);
  addWindowed(data.signal_board.biggest_drops);
  addWindowed(data.signal_board.momentum);
  addCards(data.signal_board.unusual_volume);
  addCards(data.signal_board.breakouts);
  addCards(data.signal_board.mid_movers);
  addCards(data.signal_board.budget_movers);
  addWindowed(data.signal_board.japanese_top_movers);
  addWindowed(data.signal_board.japanese_biggest_drops);
  addWindowed(data.signal_board.japanese_momentum);
  addCards(data.signal_board.japanese_mid_movers);
  addCards(data.signal_board.japanese_budget_movers);
  addCards(data.signal_board.japanese);

  return [...slugs];
}

function applyDisplayIdentityToHomepageData(
  data: HomepageData,
  identityBySlug: Map<string, CardDisplayIdentityRow>,
): HomepageData {
  return {
    ...data,
    movers: data.movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    high_confidence_movers: data.high_confidence_movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    emerging_movers: data.emerging_movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    losers: data.losers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    trending: data.trending.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    signal_board: {
      ...data.signal_board,
      market_watch: data.signal_board.market_watch.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      top_movers: applyDisplayIdentityToWindowedCards(data.signal_board.top_movers, identityBySlug),
      biggest_drops: applyDisplayIdentityToWindowedCards(data.signal_board.biggest_drops, identityBySlug),
      momentum: applyDisplayIdentityToWindowedCards(data.signal_board.momentum, identityBySlug),
      unusual_volume: data.signal_board.unusual_volume.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      breakouts: data.signal_board.breakouts.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      mid_movers: data.signal_board.mid_movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      budget_movers: data.signal_board.budget_movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      japanese_top_movers: applyDisplayIdentityToWindowedCards(data.signal_board.japanese_top_movers, identityBySlug),
      japanese_biggest_drops: applyDisplayIdentityToWindowedCards(data.signal_board.japanese_biggest_drops, identityBySlug),
      japanese_momentum: applyDisplayIdentityToWindowedCards(data.signal_board.japanese_momentum, identityBySlug),
      japanese_mid_movers: data.signal_board.japanese_mid_movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      japanese_budget_movers: data.signal_board.japanese_budget_movers.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
      japanese: data.signal_board.japanese.map((card) => applyDisplayIdentityToCard(card, identityBySlug)),
    },
  };
}

async function loadCardDisplayIdentityMap(
  client: NonNullable<ReturnType<typeof dbPublic>>,
  slugs: string[],
  logger: HomepageLogger,
): Promise<Map<string, CardDisplayIdentityRow>> {
  const identityBySlug = new Map<string, CardDisplayIdentityRow>();
  if (slugs.length === 0) return identityBySlug;

  const slugBatches = chunkValues(slugs, BATCH_LOOKUP_SLUG_LIMIT);
  const results = await Promise.all(slugBatches.map((batch) => client
    .from("public_card_display_identity")
    .select("slug, display_card_number, price_finish, price_edition, price_stamp, has_multiple_finishes")
    .in("slug", batch)));

  for (const result of results) {
    if (result.error) {
      logger.error("[homepage] card_display_identity", result.error.message);
      continue;
    }
    for (const row of (result.data ?? []) as CardDisplayIdentityRow[]) {
      if (!identityBySlug.has(row.slug)) identityBySlug.set(row.slug, row);
    }
  }

  return identityBySlug;
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

function hasProviderParityStatusForHomepage(parityStatus: string | null | undefined): boolean {
  return parityStatus === "MATCH";
}

function hasPermittedPublicMovement(params: {
  parityStatus?: string | null;
  confidenceStatus?: string | null;
  publicInputStatus?: string | null;
  movementHistorySource?: string | null;
  historyPoints30d?: number | string | null;
  changePct24h?: number | null;
  changePct7d?: number | null;
}): boolean {
  return hasProviderParityStatusForHomepage(params.parityStatus)
    && params.publicInputStatus === "SUPPORTED"
    && params.confidenceStatus === "HIGH"
    && params.movementHistorySource === "PERMITTED_MARKET_INPUT"
    && (toFiniteChange(params.changePct24h) !== null || toFiniteChange(params.changePct7d) !== null)
    && (toFiniteCount(params.historyPoints30d) ?? 0) >= MIN_PUBLIC_MOVER_HISTORY_POINTS;
}

export function hasProviderParityForHomepage(row: Pick<ChangeCandidateRow, "market_provenance" | "change_pct_24h" | "change_pct_7d">): boolean {
  return hasPermittedPublicMovement({
    parityStatus: row.market_provenance?.parityStatus,
    confidenceStatus: row.market_provenance?.confidenceStatus,
    publicInputStatus: row.market_provenance?.publicInputStatus,
    movementHistorySource: row.market_provenance?.movementHistorySource,
    historyPoints30d: row.market_provenance?.sampleCounts7d?.public ?? row.market_provenance?.sampleCounts7d?.scrydex,
    changePct24h: row.change_pct_24h,
    changePct7d: row.change_pct_7d,
  });
}

function hasPermittedPublicPulse(marketPulse: CanonicalMarketPulse | null | undefined): boolean {
  return hasPermittedPublicMovement({
    parityStatus: marketPulse?.parityStatus,
    confidenceStatus: marketPulse?.confidenceStatus,
    publicInputStatus: marketPulse?.publicInputStatus,
    movementHistorySource: marketPulse?.movementHistorySource,
    historyPoints30d: marketPulse?.sampleCounts7d?.public ?? marketPulse?.snapshotCount30d,
    changePct24h: marketPulse?.changePct24h,
    changePct7d: marketPulse?.changePct7d,
  });
}

export function hasJpNativeHomepagePriceSource(source: string | null | undefined): boolean {
  return source === "yahoo_jp" || source === "snkrdunk";
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
    let marketWatchRows: ChangeCandidateRow[] = [];
    let trendingVariants: VariantRow[] = [];
    let cardsRows: CardRow[] = [];
    let marketPulseMap = new Map<string, CanonicalMarketPulse>();
    let imageRows: ImageRow[] = [];
    let sparklineRows: SparklineRow[] = [];
    let pricesRefreshedToday: number | null = null;
    let trackedCardsWithLivePrice: number | null = null;
    let dailyMovers: DailyMoverBundle = { ...EMPTY_DAILY_MOVER_BUNDLE };

    if (overrides) {
      positiveChangeRows = overrides.positiveChangeRows ?? [];
      negativeChangeRows = overrides.negativeChangeRows ?? [];
      marketWatchRows = overrides.marketWatchRows ?? [];
      trendingVariants = dedupVariants(overrides.trendingVariants ?? [], CANDIDATE_FETCH_LIMIT);
      cardsRows = overrides.cards ?? [];
      marketPulseMap = overrides.marketPulseMap ?? new Map<string, CanonicalMarketPulse>();
      imageRows = overrides.images ?? [];
      sparklineRows = overrides.sparklineRows ?? [];
      pricesRefreshedToday = overrides.pricesRefreshedToday ?? null;
      trackedCardsWithLivePrice = overrides.trackedCardsWithLivePrice ?? null;
      dailyMovers = overrides.dailyMovers ?? { ...EMPTY_DAILY_MOVER_BUNDLE };
    } else {
      const client = db;
      if (!client) return EMPTY;

      // ── Batch 1: movers + variant-level trend data + canonical counts ──
      const [positiveChangeResult, negativeChangeResult, marketWatchResult, trendingVariantResult, refreshedCountResult, trackedCountResult] = await Promise.all([
        // 1. Top movers — prefer 24h, then fall back to 7d when 24h is unavailable.
        // Order by the change itself (not `market_price_as_of`) so the fallback
        // is stable between requests: "biggest mover wins" instead of
        // "whichever card the refresh cron just touched wins". The freshness
        // filter is already applied via `market_price_as_of >= recentMarketCutoffIso`.
        client
          .from("public_card_metrics")
          .select("canonical_slug, market_price, market_price_as_of, snapshot_count_30d, change_pct_24h, change_pct_7d, market_confidence_score, market_low_confidence, active_listings_7d, market_provenance")
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
          .select("canonical_slug, market_price, market_price_as_of, snapshot_count_30d, change_pct_24h, change_pct_7d, market_confidence_score, market_low_confidence, active_listings_7d, market_provenance")
          .eq("grade", "RAW")
          .is("printing_id", null)
          .gte("market_price", MIN_MOVER_PRICE)
          .gte("market_price_as_of", recentMarketCutoffIso)
          .or("change_pct_24h.lt.0,change_pct_7d.lt.0")
          .order("change_pct_24h", { ascending: true, nullsFirst: false })
          .order("change_pct_7d", { ascending: true, nullsFirst: false })
          .order("market_confidence_score", { ascending: false })
          .limit(LIVE_CANDIDATE_FETCH_LIMIT),

        // 3. Market watch -- trusted recent EN prices that actually moved in
        // the last 24h. Movement-aware (2026-05-30): the rail used to make no
        // movement claim, which surfaced flat cards (e.g. a $1,370 card sitting
        // at 0.0% overnight) that read as "why is this here?" on the homepage.
        // Now it requires a meaningful 24h move (|change| >= 1%).
        client
          .from("public_card_metrics")
          .select("canonical_slug, market_price, market_price_as_of, market_price_display_state, recent_market_signal_usd, recent_market_signal_as_of, recent_market_signal_delta_pct, recent_market_signal_direction, snapshot_count_30d, change_pct_24h, change_pct_7d, market_confidence_score, market_low_confidence, market_blend_policy, active_listings_7d, market_provenance")
          .eq("grade", "RAW")
          .is("printing_id", null)
          .eq("language", "EN")
          .eq("market_blend_policy", "POPALPHA_MARKET_CONFIDENT")
          .not("market_price", "is", null)
          .gte("market_price_as_of", recentMarketCutoffIso)
          .or("change_pct_24h.gte.1,change_pct_24h.lte.-1")
          .order("market_confidence_score", { ascending: false })
          .order("active_listings_7d", { ascending: false, nullsFirst: false })
          .order("market_price_as_of", { ascending: false, nullsFirst: false })
          .limit(MARKET_WATCH_CANDIDATE_FETCH_LIMIT),

        // 4. Trending — positive slope with activity from variant_metrics
        client
          .from("public_variant_metrics")
          .select("canonical_slug, provider_trend_slope_7d, provider_price_changes_count_30d, updated_at")
          .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
          .eq("grade", "RAW")
          .gt("provider_trend_slope_7d", 0)
          .gte("provider_price_changes_count_30d", MIN_CHANGES_TRENDING)
          .order("provider_trend_slope_7d", { ascending: false })
          .limit(CANDIDATE_FETCH_LIMIT),

        // 5. Count of cards with a fresh price update in the last 24h
        client
          .from("public_card_metrics")
          .select("canonical_slug", { count: "exact", head: true })
          .eq("grade", "RAW")
          .is("printing_id", null)
          .not("market_price", "is", null)
          .gte("market_price_as_of", refreshedTodayCutoffIso),

        // 6. Count of canonical RAW cards with a live market price
        client
          .from("public_card_metrics")
          .select("canonical_slug", { count: "exact", head: true })
          .eq("grade", "RAW")
          .is("printing_id", null)
          .not("market_price", "is", null),
      ]);

      if (positiveChangeResult.error) logger.error("[homepage] movers_24h", positiveChangeResult.error.message);
      if (negativeChangeResult.error) logger.error("[homepage] drops_24h", negativeChangeResult.error.message);
      if (marketWatchResult.error) logger.error("[homepage] market_watch", marketWatchResult.error.message);
      if (trendingVariantResult.error) logger.error("[homepage] trending", trendingVariantResult.error.message);
      if (refreshedCountResult.error) logger.error("[homepage] refreshed_count", refreshedCountResult.error.message);
      if (trackedCountResult.error) logger.error("[homepage] tracked_count", trackedCountResult.error.message);

      positiveChangeRows = ((positiveChangeResult.data ?? []) as ChangeCandidateRow[])
        .filter(hasProviderParityForHomepage);
      negativeChangeRows = ((negativeChangeResult.data ?? []) as ChangeCandidateRow[])
        .filter(hasProviderParityForHomepage);
      marketWatchRows = (marketWatchResult.data ?? []) as ChangeCandidateRow[];
      // EN sustained-trending used to come from provider variant slopes.
      // Keep this empty until we have a permitted observed-price movement
      // layer with enough history for homepage claims.
      trendingVariants = [];
      pricesRefreshedToday = refreshedCountResult.count ?? null;
      trackedCardsWithLivePrice = trackedCountResult.count ?? null;
    }

    // Load the stable daily rail membership before metadata enrichment so
    // its slugs are included in the current public_card_metrics lookup below.
    if (!overrides && db) {
      try {
        dailyMovers = await loadDailyTopMoversBundle(db, nowMs);
      } catch (err) {
        logger.error(
          "[homepage] daily_top_movers",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ── Collect all unique slugs ──────────────────────────────────────────
    const allSlugs = new Set<string>();
    for (const r of positiveChangeRows) allSlugs.add(r.canonical_slug);
    for (const r of negativeChangeRows) allSlugs.add(r.canonical_slug);
    for (const r of marketWatchRows) allSlugs.add(r.canonical_slug);
    for (const r of trendingVariants) allSlugs.add(r.canonical_slug);
    for (const card of collectDailyMoverBundleCards(dailyMovers)) allSlugs.add(card.slug);

    // JP rails are sourced independently from the EN mover queries —
    // they read canonical_cards JOIN public_card_metrics filtered to
    // language='JP'. Load them BEFORE the EN-only early-return guard
    // below so JP-mode users still see populated rails when EN has no
    // mover candidates (which would otherwise short-circuit the rest
    // of this function and return empty rails for both markets).
    let japaneseRail: HomepageCard[] = [];
    let japaneseRails: JpRailBundle = {
      topMovers: createEmptyWindowedCards(),
      biggestDrops: createEmptyWindowedCards(),
      momentum: createEmptyWindowedCards(),
      midMovers: [],
      budgetMovers: [],
    };
    if (!overrides && db) {
      try {
        const [jpRail, jpRails, jpMid, jpBudget] = await Promise.all([
          loadJapaneseRail(db, JAPANESE_RAIL_LIMIT),
          loadJapaneseSignalRails(db, SECTION_LIMIT),
          // Mid ($8-50) and Budget (<$8) price-tier discovery rails. The
          // change_pct-based mid/budget rails in loadJapaneseSignalRails stay
          // empty until JP movers data lands (~mid-June), so populate these from
          // the priced cohort by price tier (freshest first) for now.
          loadJapaneseRail(db, JAPANESE_RAIL_LIMIT, { minPrice: JP_MID_MIN_PRICE, maxPrice: JP_PREMIUM_MIN_PRICE }),
          loadJapaneseRail(db, JAPANESE_RAIL_LIMIT, { minPrice: JP_BUDGET_MIN_PRICE, maxPrice: JP_MID_MIN_PRICE }),
        ]);
        japaneseRail = jpRail;
        // Prefer the signal-ranked (change_pct) mid/budget rails once they have
        // data (~mid-June); fall back to the price-tier discovery rails while
        // they're still empty so the JP home isn't a single rail today.
        japaneseRails = {
          ...jpRails,
          midMovers: jpRails.midMovers.length > 0 ? jpRails.midMovers : jpMid,
          budgetMovers: jpRails.budgetMovers.length > 0 ? jpRails.budgetMovers : jpBudget,
        };
      } catch (err) {
        logger.error(
          "[homepage] japanese_rail",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const enrichDisplayIdentity = async (data: HomepageData): Promise<HomepageData> => {
      const slugs = collectHomepageDataSlugs(data);
      const identityBySlug = overrides
        ? new Map((overrides.displayIdentities ?? []).map((row) => [row.slug, row] as const))
        : db
          ? await loadCardDisplayIdentityMap(db, slugs, logger)
          : new Map<string, CardDisplayIdentityRow>();
      return applyDisplayIdentityToHomepageData(data, identityBySlug);
    };

    if (allSlugs.size === 0) {
      // EN-only early return path. Hand back the (potentially populated)
      // JP rails so a market-toggle flip still surfaces JP cards even
      // when the EN mover candidate set is empty. The EN signal-board
      // fields stay empty since their underlying queries returned no
      // candidates.
      return await enrichDisplayIdentity({
        ...EMPTY,
        prices_refreshed_today: pricesRefreshedToday,
        tracked_cards_with_live_price: trackedCardsWithLivePrice,
        signal_board: {
          ...EMPTY.signal_board,
          japanese: japaneseRail,
          japanese_top_movers: japaneseRails.topMovers,
          japanese_biggest_drops: japaneseRails.biggestDrops,
          japanese_momentum: japaneseRails.momentum,
          japanese_mid_movers: japaneseRails.midMovers,
          japanese_budget_movers: japaneseRails.budgetMovers,
        },
      });
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
          .select("slug, canonical_name, set_name, year, card_number, primary_image_url, mirrored_primary_image_url, mirrored_primary_thumb_url")
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
          .not("variant_ref", "ilike", "%::GRADED::%")
          .eq("currency", "USD")
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
    for (const row of marketWatchRows) {
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
        suppressChange?: boolean;
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

      if (overrides.suppressChange) {
        selectedChangePct = null;
        selectedChangeWindow = null;
      } else if (overrides.preferOverrideChange && overrideChangePct !== null) {
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
      // Price + as-of follow the freshest hero (latest_price) so the homepage
      // card price matches the detail hero; fall back to the median when absent.
      const priceAsOf = marketPulse?.latestPriceAsOf ?? marketPulse?.marketPriceAsOf ?? null;
      const updatedAt = typeof priceAsOf === "string" && priceAsOf.length > 0
        ? priceAsOf
        : null;
      return {
        slug,
        name: card?.canonical_name ?? slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        card_number: card?.card_number ?? null,
        market_price: marketPulse?.latestPrice ?? marketPulse?.marketPrice ?? overrides.fallbackPrice ?? null,
        market_price_display_state: marketPulse?.marketPriceDisplayState ?? null,
        recent_market_signal_usd: marketPulse?.recentMarketSignalUsd ?? null,
        recent_market_signal_as_of: marketPulse?.recentMarketSignalAsOf ?? null,
        recent_market_signal_delta_pct: marketPulse?.recentMarketSignalDeltaPct ?? null,
        recent_market_signal_direction: marketPulse?.recentMarketSignalDirection ?? null,
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
        // marketPulse doesn't carry JP-source prices. Tile-mini falls back
        // to market_price for these rows.
        yahoo_jp_price: null,
        yahoo_jp_price_jpy: null,
        yahoo_jp_sample_count: null,
        snkrdunk_price: null,
        snkrdunk_price_jpy: null,
        snkrdunk_sample_count: null,
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
      if (!hasPermittedPublicPulse(marketPulse)) { if (preferredWindow === null) positiveRejects.noMarketPulse++; return false; }
      const marketPrice = marketPulse.marketPrice ?? row.market_price ?? null;
      if (marketPrice == null) { if (preferredWindow === null) positiveRejects.priceTooLow++; return false; }
      if (SENTINEL_PRICES.has(Number(marketPrice.toFixed(2)))) { if (preferredWindow === null) positiveRejects.priceTooLow++; return false; }
      if (marketPrice < MIN_MOVER_PRICE) { if (preferredWindow === null) positiveRejects.priceTooLow++; return false; }
      const publicHistoryPoints30d = marketPulse.snapshotCount30d ?? marketPulse.sampleCounts7d?.public ?? 0;
      if (publicHistoryPoints30d < MIN_PUBLIC_MOVER_HISTORY_POINTS) { if (preferredWindow === null) positiveRejects.snapshotTooLow++; return false; }
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
      if (!hasPermittedPublicPulse(marketPulse)) { if (preferredWindow === null) negativeRejects.noMarketPulse++; return false; }
      const price = marketPulse.marketPrice ?? row.market_price ?? null;
      if (price == null || price < MIN_MOVER_PRICE) { if (preferredWindow === null) negativeRejects.priceTooLow++; return false; }
      const publicHistoryPoints30d = marketPulse.snapshotCount30d ?? marketPulse.sampleCounts7d?.public ?? 0;
      if (publicHistoryPoints30d < MIN_PUBLIC_MOVER_HISTORY_POINTS) { if (preferredWindow === null) negativeRejects.snapshotTooLow++; return false; }
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

    type MarketWatchBand = "premium" | "mid" | "budget" | "low";
    type MarketWatchCandidate = {
      row: ChangeCandidateRow;
      card: HomepageCard;
      band: MarketWatchBand;
      setKey: string;
      confidenceScore: number;
      activeListings7d: number;
      asOfMs: number;
    };
    const marketWatchRejects = {
      excluded: 0,
      noCard: 0,
      noPulse: 0,
      noPrice: 0,
      stale: 0,
      lowConfidence: 0,
      notTrusted: 0,
    };
    const marketWatchBandForPrice = (price: number): MarketWatchBand => {
      if (price >= 100) return "premium";
      if (price >= 25) return "mid";
      if (price >= 2) return "budget";
      return "low";
    };
    const compareMarketWatchCandidates = (left: MarketWatchCandidate, right: MarketWatchCandidate): number => {
      const confidenceDelta = right.confidenceScore - left.confidenceScore;
      if (confidenceDelta !== 0) return confidenceDelta;
      const activeDelta = right.activeListings7d - left.activeListings7d;
      if (activeDelta !== 0) return activeDelta;
      const asOfDelta = right.asOfMs - left.asOfMs;
      if (asOfDelta !== 0) return asOfDelta;
      return (right.card.market_price ?? 0) - (left.card.market_price ?? 0);
    };

    const marketWatchCandidates: MarketWatchCandidate[] = [];
    for (const row of marketWatchRows) {
      if (excludedSlugSet.has(row.canonical_slug)) { marketWatchRejects.excluded++; continue; }
      const baseCard = cardMap.get(row.canonical_slug);
      if (!baseCard) { marketWatchRejects.noCard++; continue; }
      const marketPulse = marketPulseMap.get(row.canonical_slug);
      if (!marketPulse) { marketWatchRejects.noPulse++; continue; }
      const price = marketPulse.marketPrice ?? row.market_price ?? null;
      if (price == null || price <= 0 || SENTINEL_PRICES.has(Number(price.toFixed(2)))) {
        marketWatchRejects.noPrice++;
        continue;
      }
      const asOf = marketPulse.marketPriceAsOf ?? row.market_price_as_of ?? null;
      const stalenessHours = hoursSince(asOf, nowMs);
      if (stalenessHours === null || stalenessHours > RECENT_MARKET_MAX_AGE_HOURS) {
        marketWatchRejects.stale++;
        continue;
      }
      const confidenceScore = marketPulse.confidenceScore ?? row.market_confidence_score ?? 0;
      if (marketPulse.lowConfidence === true || row.market_low_confidence === true || confidenceScore < MIN_CONFIDENCE_SCORE) {
        marketWatchRejects.lowConfidence++;
        continue;
      }
      const displayState = marketPulse.marketPriceDisplayState ?? row.market_price_display_state ?? null;
      const blendPolicy = marketPulse.blendPolicy ?? row.market_blend_policy ?? null;
      if (
        blendPolicy !== "POPALPHA_MARKET_CONFIDENT"
        || displayState === "UNDER_REVIEW"
        || displayState === "NO_RELIABLE_PRICE"
      ) {
        marketWatchRejects.notTrusted++;
        continue;
      }
      marketWatchCandidates.push({
        row,
        card: toCard(row.canonical_slug, {
          fallbackPrice: row.market_price,
          // Show the 24h/7d move. This was suppressed because the change used to
          // be computed off a different basis than the displayed price (the
          // Scrydex series vs the PriceCharting hero), so a badge here could
          // contradict the price. Post the chart-series-truth fix, change_pct is
          // the same median basis as the hero, so the badge is now consistent.
          // allowSparklineFallback stays false — only ever show a real move.
          allowSparklineFallback: false,
        }),
        band: marketWatchBandForPrice(price),
        setKey: (baseCard.set_name ?? "__unknown_set__").toLowerCase(),
        confidenceScore,
        activeListings7d: marketPulse.activeListings7d ?? row.active_listings_7d ?? 0,
        asOfMs: asOf ? Date.parse(asOf) : 0,
      });
    }
    marketWatchCandidates.sort(compareMarketWatchCandidates);

    const marketWatchSetCounts = new Map<string, number>();
    const marketWatchPickedSlugs = new Set<string>();
    const marketWatchPicked: HomepageCard[] = [];
    const pickMarketWatchCandidate = (candidate: MarketWatchCandidate, setCap = 2): boolean => {
      if (marketWatchPickedSlugs.has(candidate.card.slug)) return false;
      const setCount = marketWatchSetCounts.get(candidate.setKey) ?? 0;
      if (setCount >= setCap) return false;
      marketWatchSetCounts.set(candidate.setKey, setCount + 1);
      marketWatchPickedSlugs.add(candidate.card.slug);
      marketWatchPicked.push(candidate.card);
      return true;
    };
    const perBandTarget = Math.ceil(MARKET_WATCH_LIMIT / 4);
    for (const band of ["premium", "mid", "budget", "low"] as const) {
      let pickedForBand = 0;
      for (const candidate of marketWatchCandidates) {
        if (candidate.band !== band) continue;
        if (pickMarketWatchCandidate(candidate)) pickedForBand++;
        if (pickedForBand >= perBandTarget || marketWatchPicked.length >= MARKET_WATCH_LIMIT) break;
      }
      if (marketWatchPicked.length >= MARKET_WATCH_LIMIT) break;
    }
    for (const candidate of marketWatchCandidates) {
      if (marketWatchPicked.length >= MARKET_WATCH_LIMIT) break;
      pickMarketWatchCandidate(candidate);
    }
    const marketWatchOut = marketWatchPicked.slice(0, MARKET_WATCH_LIMIT);

    logger.info("[homepage.telemetry.filter_pipeline]", JSON.stringify({
      batch1: { positiveChangeRows: positiveChangeRows.length, negativeChangeRows: negativeChangeRows.length, marketWatchRows: marketWatchRows.length, trendingVariants: trendingVariants.length, allSlugs: allSlugs.size },
      jsFiltered: { marketWatch: marketWatchOut.length, movers: mixedPositiveMovers.all.length, highConfidence: mixedPositiveMovers.highConfidence.length, emerging: mixedPositiveMovers.emerging.length, losers: mixedNegativeMovers.cards.length },
      positiveRejects,
      negativeRejects,
      marketWatchRejects,
    }));

    // ── Trending: filter to cards with real prices above MIN_PRICE ────────
    const trendingCandidatesOut: HomepageCard[] = [];
    for (const row of trendingVariants) {
      if (excludedSlugSet.has(row.canonical_slug)) continue;
      const marketPulse = marketPulseMap.get(row.canonical_slug);
      if (!marketPulse) continue;
      if (!hasPermittedPublicPulse(marketPulse)) continue;
      const price = marketPulse.marketPrice ?? null;
      if (price == null || price < MIN_PRICE) continue;
      const trendPct = marketPulse.changePct7d ?? marketPulse.changePct24h;
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
    // Unusual observed activity: cards (any direction) whose 7d price
    // observation count is notably above the pool median. This is not
    // marketplace supply or active listing count.
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

    // JP rails were hoisted above the EN-only early-return guard so
    // the data is already loaded by this point. See the load block
    // earlier in this function (just before `if (allSlugs.size === 0)`).

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

    // Daily rows decide stable rail membership; current public_card_metrics
    // decides the user-visible price/as-of. This prevents stale daily
    // snapshots from disagreeing with the card detail page.
    const repriceDailyCards = (cards: HomepageCard[]): HomepageCard[] => cards.flatMap((card) => {
      const marketPulse = marketPulseMap.get(card.slug);
      if (!marketPulse) return [];
      if (!hasPermittedPublicPulse(marketPulse)) return [];
      const currentChange = card.change_window === "24H"
        ? marketPulse.changePct24h
        : card.change_window === "7D"
          ? marketPulse.changePct7d
          : marketPulse.changePct;
      // Prefer the fresh canonical change — it keeps the homepage in step
      // with the detail page when a daily snapshot goes stale (a stale
      // daily +18% gets corrected to the current +4%). But fall back to the
      // daily compute's own change when the canonical one is missing or
      // flat (0): the canonical aggregate can read 0.0% for a card that
      // genuinely moved at the per-printing level — the granularity the
      // daily compute ranked it on — so without this a real mover surfaced
      // at a misleading 0.0% (e.g. N's Zoroark ex: per-printing +4.06% 24H
      // but canonical 0.00%). Price + as-of still reprice via toCard below.
      const effectiveChange = currentChange !== null && currentChange !== 0
        ? currentChange
        : card.change_pct;
      if (effectiveChange === null || card.change_window === null) return [];
      return [toCard(card.slug, {
        mover_tier: card.mover_tier,
        changePct: effectiveChange,
        changeWindow: card.change_window,
        preferOverrideChange: true,
        allowSparklineFallback: false,
      })];
    });
    const dailyMoversForDisplay: DailyMoverBundle = {
      gainers: repriceDailyCards(dailyMovers.gainers),
      losers: repriceDailyCards(dailyMovers.losers),
      momentum_24h: repriceDailyCards(dailyMovers.momentum_24h),
      momentum_7d: repriceDailyCards(dailyMovers.momentum_7d),
      budget_gainers: repriceDailyCards(dailyMovers.budget_gainers),
      mid_gainers: repriceDailyCards(dailyMovers.mid_gainers),
      mid_losers: repriceDailyCards(dailyMovers.mid_losers),
      mid_momentum_24h: repriceDailyCards(dailyMovers.mid_momentum_24h),
      mid_momentum_7d: repriceDailyCards(dailyMovers.mid_momentum_7d),
      computed_at_date: dailyMovers.computed_at_date,
    };

    // Split the daily list by change_window so the UI's 24H/7D pills still
    // work. If one window is empty in the daily list, fall back to the other.
    const dailyGainers24H = dailyMoversForDisplay.gainers.filter((c) => c.change_window === "24H");
    const dailyGainers7D = dailyMoversForDisplay.gainers.filter((c) => c.change_window === "7D");
    const dailyLosers24H = dailyMoversForDisplay.losers.filter((c) => c.change_window === "24H");
    const dailyLosers7D = dailyMoversForDisplay.losers.filter((c) => c.change_window === "7D");

    const signalBoard = {
      market_watch: marketWatchOut,
      top_movers: {
        "24H": dailyGainers24H.length > 0
          ? dailyGainers24H.slice(0, SECTION_LIMIT)
          : (dailyMoversForDisplay.gainers.length > 0
            ? dailyMoversForDisplay.gainers.slice(0, SECTION_LIMIT)
            : liveTopMovers24H),
        "7D": dailyGainers7D.length > 0
          ? dailyGainers7D.slice(0, SECTION_LIMIT)
          : (dailyMoversForDisplay.gainers.length > 0
            ? dailyMoversForDisplay.gainers.slice(0, SECTION_LIMIT)
            : liveTopMovers7D),
      },
      biggest_drops: {
        "24H": dailyLosers24H.length > 0
          ? dailyLosers24H.slice(0, SECTION_LIMIT)
          : (dailyMoversForDisplay.losers.length > 0
            ? dailyMoversForDisplay.losers.slice(0, SECTION_LIMIT)
            : liveDrops24H),
        "7D": dailyLosers7D.length > 0
          ? dailyLosers7D.slice(0, SECTION_LIMIT)
          : (dailyMoversForDisplay.losers.length > 0
            ? dailyMoversForDisplay.losers.slice(0, SECTION_LIMIT)
            : liveDrops7D),
      },
      momentum: {
        // Prefer the daily-computed momentum rails so the iOS For You
        // rail (which prefers momentum over top_movers) doesn't flip
        // every app open. Fall back to live compute if today's daily
        // list is missing.
        "24H": dailyMoversForDisplay.momentum_24h.length > 0
          ? dailyMoversForDisplay.momentum_24h.slice(0, SECTION_LIMIT)
          : combineHomepageCards([
              positiveMoversByWindow["24H"].emerging,
              positiveMoversByWindow["24H"].highConfidence,
              positiveMoversByWindow["24H"].all,
            ]),
        "7D": dailyMoversForDisplay.momentum_7d.length > 0
          ? dailyMoversForDisplay.momentum_7d.slice(0, SECTION_LIMIT)
          : combineHomepageCards([
              trendingCandidatesOut,
              positiveMoversByWindow["7D"].all,
            ]),
      },
      unusual_volume: unusualVolumeOut,
      breakouts: breakoutsOut,
      mid_movers: dailyMoversForDisplay.mid_gainers.slice(0, SECTION_LIMIT),
      budget_movers: dailyMoversForDisplay.budget_gainers.slice(0, SECTION_LIMIT),
      japanese_top_movers: japaneseRails.topMovers,
      japanese_biggest_drops: japaneseRails.biggestDrops,
      japanese_momentum: japaneseRails.momentum,
      japanese_mid_movers: japaneseRails.midMovers,
      japanese_budget_movers: japaneseRails.budgetMovers,
      japanese: japaneseRail,
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

    const output: HomepageData = {
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
    return await enrichDisplayIdentity(output);

  } catch (err) {
    logger.error("[homepage] getHomepageData failed:", err);
    return EMPTY;
  }
}
