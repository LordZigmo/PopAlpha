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
  pricedCount: number;
  pricedPct: number;
  freshCount: number;
  freshPct: number;
  latestPriceAsOf: string | null;
};

export type JapaneseCatalogState = {
  totalCards: number;
  totalSets: number;
  pricedCards: number;
  pricedPct: number;
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
 * (RAW canonical row) so the page reflects what's actually priced and
 * how recent that price is.
 *
 * Used to answer two questions before scaling up JP onboarding:
 *   1. How big is the JP catalog right now? (totals + per-set)
 *   2. How well are we keeping it priced? (priced + fresh counts)
 *
 * "Priced" = has a non-null market_price on the canonical RAW row.
 * "Fresh" = priced AND market_price_as_of within the last 7 days
 *           (matches the warm-tier window from the EN /data page so
 *            the metric is comparable across catalogs).
 */
export async function getJapaneseCatalogState(): Promise<JapaneseCatalogState> {
  const supabase = publicSupabase();

  // 1. Pull every JP canonical card with its set name.
  const { data: cards, error: cardsError } = await supabase
    .from("canonical_cards")
    .select("slug, set_name, year")
    .eq("language", "JP")
    .returns<Array<{
      slug: string;
      set_name: string | null;
      year: number | null;
    }>>();
  if (cardsError) throw new Error(`canonical_cards(JP): ${cardsError.message}`);

  if (!cards || cards.length === 0) {
    return {
      totalCards: 0,
      totalSets: 0,
      pricedCards: 0,
      pricedPct: 0,
      freshCards: 0,
      freshPct: 0,
      latestPriceAsOf: null,
      sets: [],
    };
  }

  // 2. Look up the canonical RAW market price for every JP slug. Price
  //    rows are keyed by (slug, printing_id, grade); printing_id IS NULL
  //    + grade='RAW' is the canonical row that feeds card-detail pricing.
  const slugs = cards.map((row) => row.slug);
  type PriceRow = {
    canonical_slug: string;
    market_price: number | null;
    market_price_as_of: string | null;
  };
  const priceMap = new Map<string, PriceRow>();
  for (let i = 0; i < slugs.length; i += 200) {
    const chunk = slugs.slice(i, i + 200);
    const { data, error } = await supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price, market_price_as_of")
      .eq("grade", "RAW")
      .is("printing_id", null)
      .in("canonical_slug", chunk);
    if (error) throw new Error(`public_card_metrics(JP): ${error.message}`);
    for (const row of (data ?? []) as PriceRow[]) {
      if (row.canonical_slug) priceMap.set(row.canonical_slug, row);
    }
  }

  // 3. Roll up per-set + global totals.
  const nowMs = Date.now();
  const setMap = new Map<string, JapaneseSetEntry>();
  let pricedCards = 0;
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
        pricedCount: 0,
        pricedPct: 0,
        freshCount: 0,
        freshPct: 0,
        latestPriceAsOf: null,
      };
      setMap.set(setKey, entry);
    }
    entry.cardCount += 1;

    const price = priceMap.get(card.slug);
    if (price?.market_price != null && price.market_price > 0) {
      pricedCards += 1;
      entry.pricedCount += 1;
      const asOf = price.market_price_as_of;
      if (typeof asOf === "string" && asOf.length > 0) {
        const asOfMs = Date.parse(asOf);
        if (Number.isFinite(asOfMs)) {
          if (asOfMs > nowMs - JAPANESE_FRESH_WINDOW_MS) {
            freshCards += 1;
            entry.freshCount += 1;
          }
          if (asOfMs > latestPriceAsOfMs) {
            latestPriceAsOfMs = asOfMs;
            latestPriceAsOf = asOf;
          }
          if (!entry.latestPriceAsOf || asOfMs > Date.parse(entry.latestPriceAsOf)) {
            entry.latestPriceAsOf = asOf;
          }
        }
      }
    }
  }

  // 4. Finalize per-set percentages and sort by year desc, then name.
  const sets = [...setMap.values()].map((entry) => ({
    ...entry,
    pricedPct: entry.cardCount > 0 ? (entry.pricedCount / entry.cardCount) * 100 : 0,
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
    pricedCards,
    pricedPct: cards.length > 0 ? (pricedCards / cards.length) * 100 : 0,
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
