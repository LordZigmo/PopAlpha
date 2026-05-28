/**
 * lib/data/tier-summary.ts
 *
 * Server-side data helpers for the public /data page. The page is the
 * consumer-facing transparency story for how PopAlpha prices Pokemon
 * cards: every card carries a `refresh_tier` (hot / warm / sparse /
 * dormant) that determines how often we refresh its price and how we
 * present that price in the UI.
 *
 * Two queries:
 *   - getTierSummary(): tier counts + last-classified timestamp
 *   - getPipelineStatus(): is the homepage rails refresh up to date?
 *
 * Both are intentionally tiny. The page replaces the old freshness
 * monitor that scanned 12M+ rows in price_history_points; this version
 * reads only canonical_cards (~23k rows) and daily_top_movers (one row
 * per kind per day).
 */
import { createClient } from "@supabase/supabase-js";

export type RefreshTier = "hot" | "warm" | "sparse" | "dormant";

export type TierSummaryEntry = {
  tier: RefreshTier;
  count: number;
  pct: number;
};

export type TierSummary = {
  tiers: TierSummaryEntry[];
  total: number;
  computedAt: string | null;
};

export type PipelineStatusState = "live" | "catching_up" | "stale" | "unknown";

export type PipelineStatus = {
  state: PipelineStatusState;
  latestRailsComputedAt: string | null;
  daysStale: number | null;
};

const TIER_ORDER: RefreshTier[] = ["hot", "warm", "sparse", "dormant"];

function publicSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("tier-summary: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getTierSummary(): Promise<TierSummary> {
  const supabase = publicSupabase();
  const counts: Record<RefreshTier, number> = { hot: 0, warm: 0, sparse: 0, dormant: 0 };

  for (const tier of TIER_ORDER) {
    const { count, error } = await supabase
      .from("canonical_cards")
      .select("slug", { count: "exact", head: true })
      .eq("refresh_tier", tier);
    if (error) throw new Error(`canonical_cards(tier=${tier}): ${error.message}`);
    counts[tier] = count ?? 0;
  }

  const total = TIER_ORDER.reduce((sum, t) => sum + counts[t], 0);

  const { data: latest } = await supabase
    .from("canonical_cards")
    .select("refresh_tier_computed_at")
    .not("refresh_tier_computed_at", "is", null)
    .order("refresh_tier_computed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ refresh_tier_computed_at: string }>();

  const tiers: TierSummaryEntry[] = TIER_ORDER.map((tier) => ({
    tier,
    count: counts[tier],
    pct: total > 0 ? (counts[tier] / total) * 100 : 0,
  }));

  return {
    tiers,
    total,
    computedAt: latest?.refresh_tier_computed_at ?? null,
  };
}

export type JapaneseSetEntry = {
  setName: string;
  year: number | null;
  cardCount: number;
  /** Cards with at least one rollup row in public_card_metrics — proxy for "the matching pipeline attached this card to its observations". */
  matchedCount: number;
  matchedPct: number;
  /** Cards with a canonical RAW market_price (the headline price for ungraded singles). */
  rawPriceCount: number;
  rawPricePct: number;
  freshCount: number;
  freshPct: number;
  latestPriceAsOf: string | null;
};

export type JapaneseCatalogState = {
  totalCards: number;
  totalSets: number;
  /** Cards with at least one rollup row in public_card_metrics. The matching pipeline's success rate. */
  matchedCards: number;
  matchedPct: number;
  /** Cards with a canonical RAW market_price. */
  rawPriceCards: number;
  rawPricePct: number;
  /** RAW-priced cards observed within the last 7 days. */
  freshCards: number;
  freshPct: number;
  latestPriceAsOf: string | null;
  sets: JapaneseSetEntry[];
};

const JAPANESE_FRESH_WINDOW_DAYS = 7;
const JAPANESE_FRESH_WINDOW_MS = JAPANESE_FRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Snapshot of the Japanese catalog state for /data measurement. Looks
 * at canonical_cards (language='JP') joined with public_card_metrics
 * so the page reflects which cards the matching pipeline actually
 * attached observations to and what fraction has a headline price.
 *
 * Three coverage signals — each answers a different question:
 *
 *   "Pipeline matched"  Cards with at least one rollup row in
 *                       public_card_metrics, regardless of grade or
 *                       whether market_price is populated. This is
 *                       the matching pipeline's success rate — when
 *                       the provider pipeline returns observations for a card, did
 *                       we cleanly attach them to the canonical row.
 *                       A card with only graded slab observations
 *                       counts as matched here even though its RAW
 *                       headline is empty.
 *
 *   "Has RAW price"     Cards with a canonical RAW market_price
 *                       (printing_id IS NULL, grade='RAW') populated.
 *                       This is the user-visible headline price on
 *                       the card-detail page. By design lower than
 *                       Pipeline matched because public_card_metrics
 *                       only computes market_price for RAW rows;
 *                       graded grades carry data on other fields
 *                       (median_30d etc) but not market_price. Many
 *                       JP holos primarily trade as PSA/CGC slabs,
 *                       so RAW % is structurally lower for JP than
 *                       EN.
 *
 *   "Fresh RAW (7d)"    Subset of "Has RAW price" where the RAW
 *                       canonical row's market_price_as_of is within
 *                       the last 7 days. Matches the warm-tier window
 *                       from the EN /data page for cross-catalog
 *                       comparison.
 */
export async function getJapaneseCatalogState(): Promise<JapaneseCatalogState> {
  const supabase = publicSupabase();

  // 1. Pull every JP canonical card with its set name. Paginate via
  //    .range() because PostgREST defaults to 1000 rows per response,
  //    and the JP catalog has already crossed that threshold (2,888
  //    cards as of 2026-05-07). Without pagination the helper would
  //    silently truncate at 1000 and report a partial catalog as if
  //    it were the whole thing.
  type JpCardRow = {
    slug: string;
    set_name: string | null;
    year: number | null;
  };
  const cards: JpCardRow[] = [];
  {
    const PAGE_SIZE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("canonical_cards")
        .select("slug, set_name, year")
        .eq("language", "JP")
        .range(from, from + PAGE_SIZE - 1)
        .returns<JpCardRow[]>();
      if (error) throw new Error(`canonical_cards(JP): ${error.message}`);
      const rows = data ?? [];
      cards.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  if (cards.length === 0) {
    return {
      totalCards: 0,
      totalSets: 0,
      matchedCards: 0,
      matchedPct: 0,
      rawPriceCards: 0,
      rawPricePct: 0,
      freshCards: 0,
      freshPct: 0,
      latestPriceAsOf: null,
      sets: [],
    };
  }

  // 2. Pull every public_card_metrics row for JP slugs. Two things to
  //    extract per slug:
  //      (a) does ANY rollup row exist — "matched" (regardless of
  //          market_price, which is by-design RAW-only across the
  //          whole catalog)
  //      (b) does the canonical RAW row (printing_id IS NULL,
  //          grade='RAW') have a market_price > 0 — "RAW price"
  const slugs = cards.map((row) => row.slug);
  type RollupRow = {
    canonical_slug: string;
    market_price: number | null;
    market_price_as_of: string | null;
    printing_id: string | null;
    grade: string | null;
  };
  type SlugState = {
    hasRollup: boolean;
    rawCanonicalAsOf: string | null;
    rawCanonicalMarketPrice: number | null;
  };
  const stateBySlug = new Map<string, SlugState>();
  // Each canonical card produces ~5–10 rollup rows in public_card_metrics
  // (per-printing × per-grade fan-out). PostgREST caps responses at
  // 1000 rows by default, so a 200-slug IN-list silently truncates.
  // Use a smaller chunk size AND paginate via .range() inside each
  // chunk so we never miss rows. Chunk of 80 × ~10 rows = 800, safely
  // under the limit, and the inner pagination loop catches any chunk
  // whose fan-out runs higher (heavy graded cards).
  const PCM_CHUNK_SIZE = 80;
  const PCM_PAGE_SIZE = 1000;
  for (let i = 0; i < slugs.length; i += PCM_CHUNK_SIZE) {
    const chunk = slugs.slice(i, i + PCM_CHUNK_SIZE);
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("public_card_metrics")
        .select("canonical_slug, market_price, market_price_as_of, printing_id, grade")
        .in("canonical_slug", chunk)
        .range(from, from + PCM_PAGE_SIZE - 1);
      if (error) throw new Error(`public_card_metrics(JP): ${error.message}`);
      const rows = (data ?? []) as RollupRow[];
      for (const row of rows) {
        if (!row.canonical_slug) continue;
        let state = stateBySlug.get(row.canonical_slug);
        if (!state) {
          state = {
            hasRollup: false,
            rawCanonicalAsOf: null,
            rawCanonicalMarketPrice: null,
          };
          stateBySlug.set(row.canonical_slug, state);
        }
        state.hasRollup = true;
        if (row.printing_id === null && row.grade === "RAW" && row.market_price !== null && row.market_price > 0) {
          state.rawCanonicalMarketPrice = row.market_price;
          state.rawCanonicalAsOf = row.market_price_as_of;
        }
      }
      if (rows.length < PCM_PAGE_SIZE) break;
      from += PCM_PAGE_SIZE;
    }
  }

  // 3. Roll up per-set + global totals.
  const nowMs = Date.now();
  const setMap = new Map<string, JapaneseSetEntry>();
  let matchedCards = 0;
  let rawPriceCards = 0;
  let freshCards = 0;
  let latestPriceAsOfMs = 0;
  let latestPriceAsOf: string | null = null;

  for (const card of cards) {
    const setKey = card.set_name ?? "(unknown set)";
    let entry = setMap.get(setKey);
    if (!entry) {
      entry = {
        setName: setKey,
        year: card.year ?? null,
        cardCount: 0,
        matchedCount: 0,
        matchedPct: 0,
        rawPriceCount: 0,
        rawPricePct: 0,
        freshCount: 0,
        freshPct: 0,
        latestPriceAsOf: null,
      };
      setMap.set(setKey, entry);
    }
    entry.cardCount += 1;

    const state = stateBySlug.get(card.slug);
    if (!state) continue;

    if (state.hasRollup) {
      matchedCards += 1;
      entry.matchedCount += 1;
    }
    if (state.rawCanonicalMarketPrice !== null && state.rawCanonicalMarketPrice > 0) {
      rawPriceCards += 1;
      entry.rawPriceCount += 1;
      const asOfMs = state.rawCanonicalAsOf ? Date.parse(state.rawCanonicalAsOf) : NaN;
      if (Number.isFinite(asOfMs)) {
        if (asOfMs > nowMs - JAPANESE_FRESH_WINDOW_MS) {
          freshCards += 1;
          entry.freshCount += 1;
        }
        if (asOfMs > latestPriceAsOfMs) {
          latestPriceAsOfMs = asOfMs;
          latestPriceAsOf = state.rawCanonicalAsOf;
        }
        if (!entry.latestPriceAsOf || asOfMs > Date.parse(entry.latestPriceAsOf)) {
          entry.latestPriceAsOf = state.rawCanonicalAsOf;
        }
      }
    }
  }

  // 4. Finalize per-set percentages and sort by year desc, then name.
  const sets = [...setMap.values()].map((entry) => ({
    ...entry,
    matchedPct: entry.cardCount > 0 ? (entry.matchedCount / entry.cardCount) * 100 : 0,
    rawPricePct: entry.cardCount > 0 ? (entry.rawPriceCount / entry.cardCount) * 100 : 0,
    freshPct: entry.cardCount > 0 ? (entry.freshCount / entry.cardCount) * 100 : 0,
  }));
  sets.sort((a, b) => {
    const yearDelta = (b.year ?? 0) - (a.year ?? 0);
    if (yearDelta !== 0) return yearDelta;
    return a.setName.localeCompare(b.setName);
  });

  return {
    totalCards: cards.length,
    totalSets: sets.length,
    matchedCards,
    matchedPct: cards.length > 0 ? (matchedCards / cards.length) * 100 : 0,
    rawPriceCards,
    rawPricePct: cards.length > 0 ? (rawPriceCards / cards.length) * 100 : 0,
    freshCards,
    freshPct: cards.length > 0 ? (freshCards / cards.length) * 100 : 0,
    latestPriceAsOf,
    sets,
  };
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
  const supabase = publicSupabase();
  const { data, error } = await supabase
    .from("daily_top_movers")
    .select("computed_at_date, computed_at")
    .order("computed_at_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ computed_at_date: string; computed_at: string }>();

  if (error) throw new Error(`daily_top_movers(latest): ${error.message}`);

  if (!data) {
    return { state: "unknown", latestRailsComputedAt: null, daysStale: null };
  }

  const today = new Date().toISOString().slice(0, 10);
  const newest = data.computed_at_date;
  const daysStale = Math.max(
    0,
    Math.floor((Date.parse(today) - Date.parse(newest)) / (1000 * 60 * 60 * 24)),
  );

  let state: PipelineStatusState;
  if (daysStale === 0) state = "live";
  else if (daysStale === 1) state = "catching_up";
  else state = "stale";

  return {
    state,
    latestRailsComputedAt: data.computed_at,
    daysStale,
  };
}
