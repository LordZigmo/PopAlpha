/**
 * lib/data/homepage.ts
 *
 * Single server-side data loader for the homepage.
 * Uses dbPublic() only — no service-role access.
 *
 * Query plan (2 parallel batches, 7 queries total):
 *   Batch 1: movers (variant_movers) + variant metrics for losers/trending (parallel)
 *   Batch 2: canonical_cards metadata + card_metrics prices + provider freshness (parallel)
 *   JS merge into HomepageData
 *
 * Why two tables?
 *   - variant_metrics has provider_trend_slope_7d (for losers/trending)
 *   - card_metrics has canonical market price + deltas (for display)
 *   - refresh_card_metrics() doesn't copy trend data to canonical rows
 */

import { getCanonicalMarketPulseMap } from "@/lib/data/market";
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
  losers: HomepageCard[];
  trending: HomepageCard[];
  as_of: string | null;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SECTION_LIMIT = 5;
/** Minimum 7d median to filter noise / $0 cards */
const MIN_PRICE = 0.5;
/** Top movers must have provider updates within this freshness window. */
const TOP_MOVER_MAX_AGE_HOURS = 24;
/** Minimum trade count for "sustained trending" vs noise */
const MIN_CHANGES_TRENDING = 3;
/** Over-fetch factor for variant metrics (we filter by price in JS) */
const VARIANT_FETCH_LIMIT = 60;
const SENTINEL_PRICES = new Set([23456.78]);

// ── Loader ──────────────────────────────────────────────────────────────────

const EMPTY: HomepageData = { movers: [], losers: [], trending: [], as_of: null };

function compareMovementMagnitude(a: HomepageCard, b: HomepageCard): number {
  const aMove = typeof a.change_pct === "number" && Number.isFinite(a.change_pct) ? Math.abs(a.change_pct) : -1;
  const bMove = typeof b.change_pct === "number" && Number.isFinite(b.change_pct) ? Math.abs(b.change_pct) : -1;

  if (aMove !== bMove) return bMove - aMove;

  const aPrice = typeof a.market_price === "number" && Number.isFinite(a.market_price) ? a.market_price : -1;
  const bPrice = typeof b.market_price === "number" && Number.isFinite(b.market_price) ? b.market_price : -1;
  if (aPrice !== bPrice) return bPrice - aPrice;

  return a.name.localeCompare(b.name);
}

function deriveSparklineChangePct(points: number[]): number | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first > 0) || !Number.isFinite(first) || !Number.isFinite(last)) return null;
  return ((last - first) / first) * 100;
}

function pickNonZeroFiniteChange(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value === 0) continue;
    return value;
  }
  return null;
}

function buildChangeCoverage(section: string, cards: HomepageCard[]) {
  const total = cards.length;
  const missing = cards.filter((card) => card.change_pct == null || !Number.isFinite(card.change_pct)).length;
  const present = Math.max(0, total - missing);
  const missingPct = total > 0 ? Number(((missing / total) * 100).toFixed(1)) : 0;
  return { section, total, present, missing, missingPct };
}

export async function getHomepageData(): Promise<HomepageData> {
  let db;
  try {
    db = dbPublic();
  } catch (err) {
    console.error("[homepage] dbPublic() init failed:", err);
    return EMPTY;
  }

  try {
    const topMoverFreshCutoffIso = new Date(Date.now() - TOP_MOVER_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

    // ── Batch 1: movers + variant-level trend data ────────────────────────
    const [moversResult, losersVariantResult, trendingVariantResult] = await Promise.all([
      // 1. Top movers — hot/warming tiers, pre-joined with card_metrics prices
      db
        .from("public_variant_movers_priced")
        .select("canonical_slug, provider, mover_tier, tier_priority, median_7d, provider_trend_slope_7d, updated_at")
        .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
        .eq("grade", "RAW")
        .in("mover_tier", ["hot", "warming"])
        .gte("updated_at", topMoverFreshCutoffIso)
        .order("tier_priority", { ascending: true })
        .order("median_7d", { ascending: false })
        .limit(SECTION_LIMIT * 12),

      // 2. Losers — steepest negative trend slope from variant_metrics
      db
        .from("public_variant_metrics")
        .select("canonical_slug, provider_trend_slope_7d, provider_price_changes_count_30d, updated_at")
        .eq("provider", "JUSTTCG")
        .eq("grade", "RAW")
        .lt("provider_trend_slope_7d", 0)
        .order("provider_trend_slope_7d", { ascending: true })
        .limit(VARIANT_FETCH_LIMIT),

      // 3. Trending — positive slope with activity from variant_metrics
      db
        .from("public_variant_metrics")
        .select("canonical_slug, provider_trend_slope_7d, provider_price_changes_count_30d, updated_at")
        .eq("provider", "JUSTTCG")
        .eq("grade", "RAW")
        .gt("provider_trend_slope_7d", 0)
        .gte("provider_price_changes_count_30d", MIN_CHANGES_TRENDING)
        .order("provider_trend_slope_7d", { ascending: false })
        .limit(VARIANT_FETCH_LIMIT),
    ]);

    if (moversResult.error) console.error("[homepage] movers", moversResult.error.message);
    if (losersVariantResult.error) console.error("[homepage] losers", losersVariantResult.error.message);
    if (trendingVariantResult.error) console.error("[homepage] trending", trendingVariantResult.error.message);

    // ── Keep movers ordered, then dedupe after freshness filtering ───────
    type MoverRow = {
      canonical_slug: string;
      provider: "JUSTTCG" | "SCRYDEX" | "POKEMON_TCG_API";
      mover_tier: string;
      tier_priority: number;
      median_7d: number | null;
      provider_trend_slope_7d: number | null;
      updated_at: string;
    };
    const moversRows = (moversResult.data ?? []) as MoverRow[];

    // Deduplicate variant results by canonical_slug (keep first = best slope)
    type VariantRow = { canonical_slug: string; provider_trend_slope_7d: number | null; provider_price_changes_count_30d: number | null; updated_at: string };
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

    const loserVariants = dedupVariants((losersVariantResult.data ?? []) as VariantRow[], VARIANT_FETCH_LIMIT);
    const trendingVariants = dedupVariants((trendingVariantResult.data ?? []) as VariantRow[], VARIANT_FETCH_LIMIT);

    // ── Collect all unique slugs ──────────────────────────────────────────
    const allSlugs = new Set<string>();
    for (const r of moversRows) allSlugs.add(r.canonical_slug);
    for (const r of loserVariants) allSlugs.add(r.canonical_slug);
    for (const r of trendingVariants) allSlugs.add(r.canonical_slug);

    if (allSlugs.size === 0) return EMPTY;

    const slugArray = [...allSlugs];

    // ── Batch 2: card metadata + prices (with change pcts) + images ────
    const [cardsResult, marketPulseMap, imagesResult, sparklineResult, providerFreshnessResult] = await Promise.all([
      db
        .from("canonical_cards")
        .select("slug, canonical_name, set_name, year")
        .in("slug", slugArray),

      getCanonicalMarketPulseMap(db, slugArray),

      db
        .from("card_printings")
        .select("canonical_slug, image_url")
        .in("canonical_slug", slugArray)
        .eq("language", "EN")
        .not("image_url", "is", null)
        .limit(slugArray.length * 3),

      db
        .from("public_price_history")
        .select("canonical_slug, ts, price")
        .in("canonical_slug", slugArray)
        .eq("provider", "JUSTTCG")
        .eq("source_window", "7d")
        .order("ts", { ascending: false })
        .limit(Math.max(slugArray.length * 24, 120)),

      db
        .from("public_variant_metrics")
        .select("canonical_slug, provider, provider_as_of_ts")
        .eq("grade", "RAW")
        .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
        .in("canonical_slug", slugArray)
        .not("provider_as_of_ts", "is", null)
        .limit(10000),
    ]);

    if (cardsResult.error) console.error("[homepage] cards", cardsResult.error.message);
    if (imagesResult.error) console.error("[homepage] images", imagesResult.error.message);
    if (sparklineResult.error) console.error("[homepage] sparkline", sparklineResult.error.message);
    if (providerFreshnessResult.error) console.error("[homepage] provider freshness", providerFreshnessResult.error.message);

    // ── Build lookup maps ─────────────────────────────────────────────────
    type CardRow = { slug: string; canonical_name: string; set_name: string | null; year: number | null };
    const cardMap = new Map<string, CardRow>();
    for (const c of (cardsResult.data ?? []) as CardRow[]) {
      cardMap.set(c.slug, c);
    }

    const imageMap = new Map<string, string>();
    for (const row of (imagesResult.data ?? []) as { canonical_slug: string; image_url: string }[]) {
      if (!imageMap.has(row.canonical_slug) && row.image_url) {
        imageMap.set(row.canonical_slug, row.image_url);
      }
    }

    const sparklineMap = new Map<string, number[]>();
    for (const row of (sparklineResult.data ?? []) as { canonical_slug: string; price: number | null }[]) {
      if (!row.canonical_slug || row.price == null) continue;
      const current = sparklineMap.get(row.canonical_slug) ?? [];
      if (current.length >= 7) continue;
      current.push(row.price);
      sparklineMap.set(row.canonical_slug, current);
    }
    for (const [slug, points] of sparklineMap.entries()) {
      sparklineMap.set(slug, [...points].reverse());
    }
    const providerFreshnessMap = new Map<string, string>();
    for (const row of (providerFreshnessResult.data ?? []) as Array<{
      canonical_slug: string;
      provider: "JUSTTCG" | "SCRYDEX" | "POKEMON_TCG_API";
      provider_as_of_ts: string;
    }>) {
      const key = `${row.canonical_slug}::${row.provider}`;
      const prev = providerFreshnessMap.get(key);
      if (!prev || row.provider_as_of_ts > prev) providerFreshnessMap.set(key, row.provider_as_of_ts);
    }

    // ── Assemble helpers ──────────────────────────────────────────────────
    function toCard(
      slug: string,
      overrides: {
        fallbackPrice?: number | null;
        mover_tier?: HomepageCard["mover_tier"];
        changePct?: number | null;
        changeWindow?: "24H" | "7D" | null;
      } = {},
    ): HomepageCard {
      const card = cardMap.get(slug);
      const marketPulse = marketPulseMap.get(slug);
      const sparkline = sparklineMap.get(slug) ?? [];
      const fallbackChangePct = deriveSparklineChangePct(sparkline);
      const selectedChangePct = pickNonZeroFiniteChange(
        marketPulse?.changePct,
        overrides.changePct,
        fallbackChangePct,
      );
      const selectedChangeWindow = selectedChangePct === marketPulse?.changePct
        ? marketPulse?.changeWindow ?? null
        : selectedChangePct === overrides.changePct
          ? (overrides.changeWindow ?? null)
          : selectedChangePct === fallbackChangePct
            ? "7D"
            : null;
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

    // ── Movers: view already guarantees price > 0 ─────────────────────────
    const moversOut: HomepageCard[] = [];
    const seenMoverSlugs = new Set<string>();
    const pushMoverIfEligible = (r: MoverRow, requireProviderAsOfFresh: boolean): boolean => {
      if (seenMoverSlugs.has(r.canonical_slug)) return false;
      const marketPulse = marketPulseMap.get(r.canonical_slug);
      if (!marketPulse) return false;
      const provider = r.provider === "POKEMON_TCG_API" ? "SCRYDEX" : r.provider;
      const providerAsOf = providerFreshnessMap.get(`${r.canonical_slug}::${r.provider}`)
        ?? providerFreshnessMap.get(`${r.canonical_slug}::${provider}`);
      if (requireProviderAsOfFresh && (!providerAsOf || providerAsOf < topMoverFreshCutoffIso)) return false;
      const providerPrice = provider === "JUSTTCG" ? marketPulse.justtcgPrice : marketPulse.scrydexPrice;
      if (providerPrice == null) return false;
      if (SENTINEL_PRICES.has(Number(providerPrice.toFixed(2)))) return false;
      if (providerPrice < MIN_PRICE) return false;
      const trendPct = Number.isFinite(r.provider_trend_slope_7d ?? NaN)
        ? Number((r.provider_trend_slope_7d as number).toFixed(2))
        : null;
      moversOut.push(toCard(r.canonical_slug, {
        fallbackPrice: r.median_7d,
        mover_tier: r.mover_tier as HomepageCard["mover_tier"],
        changePct: trendPct,
        changeWindow: trendPct !== null ? "7D" : null,
      }));
      seenMoverSlugs.add(r.canonical_slug);
      return true;
    };

    // Primary: strict provider-source freshness within 24h.
    for (const r of moversRows) {
      pushMoverIfEligible(r, true);
      if (moversOut.length >= SECTION_LIMIT) break;
    }
    // Fallback: if strict filter is too thin, allow mover rows already refreshed in 24h.
    if (moversOut.length === 0) {
      for (const r of moversRows) {
        pushMoverIfEligible(r, false);
        if (moversOut.length >= SECTION_LIMIT) break;
      }
    }
    moversOut.sort(compareMovementMagnitude);

    // ── Losers: filter to cards with real prices above MIN_PRICE ─────────
    const losersOut: HomepageCard[] = [];
    for (const r of loserVariants) {
      const price = marketPulseMap.get(r.canonical_slug)?.marketPrice ?? null;
      if (price == null || price < MIN_PRICE) continue;
      losersOut.push(toCard(r.canonical_slug));
    }
    losersOut.sort(compareMovementMagnitude);
    losersOut.splice(SECTION_LIMIT);

    // ── Trending: filter to cards with real prices above MIN_PRICE ────────
    const trendingOut: HomepageCard[] = [];
    for (const r of trendingVariants) {
      const price = marketPulseMap.get(r.canonical_slug)?.marketPrice ?? null;
      if (price == null || price < MIN_PRICE) continue;
      trendingOut.push(toCard(r.canonical_slug));
    }
    trendingOut.sort(compareMovementMagnitude);
    trendingOut.splice(SECTION_LIMIT);

    // ── Derive as_of ──────────────────────────────────────────────────────
    const timestamps = [
      ...(moversResult.data ?? []).map((r: { updated_at?: string }) => r.updated_at),
      ...(losersVariantResult.data ?? []).map((r: { updated_at?: string }) => r.updated_at),
      ...(trendingVariantResult.data ?? []).map((r: { updated_at?: string }) => r.updated_at),
    ].filter(Boolean) as string[];
    const as_of = timestamps.length > 0 ? timestamps.sort().reverse()[0] : null;

    const coverage = [
      buildChangeCoverage("movers", moversOut),
      buildChangeCoverage("losers", losersOut),
      buildChangeCoverage("trending", trendingOut),
    ];
    console.info("[homepage.telemetry.change_coverage]", JSON.stringify({
      asOf: as_of,
      coverage,
    }));

    return { movers: moversOut, losers: losersOut, trending: trendingOut, as_of };

  } catch (err) {
    console.error("[homepage] getHomepageData failed:", err);
    return EMPTY;
  }
}
