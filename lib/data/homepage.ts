/**
 * lib/data/homepage.ts
 *
 * Single server-side data loader for the homepage.
 * Uses dbPublic() only — no service-role access.
 *
 * Query plan (2 parallel batches, 6 queries total):
 *   Batch 1: movers (variant_movers) + variant metrics for losers/trending (parallel)
 *   Batch 2: canonical_cards metadata + card_metrics prices (parallel)
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
/** Minimum trade count for "sustained trending" vs noise */
const MIN_CHANGES_TRENDING = 3;
/** Over-fetch factor for variant metrics (we filter by price in JS) */
const VARIANT_FETCH_LIMIT = 60;

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

export async function getHomepageData(): Promise<HomepageData> {
  let db;
  try {
    db = dbPublic();
  } catch (err) {
    console.error("[homepage] dbPublic() init failed:", err);
    return EMPTY;
  }

  try {
    // ── Batch 1: movers + variant-level trend data ────────────────────────
    const [moversResult, losersVariantResult, trendingVariantResult] = await Promise.all([
      // 1. Top movers — hot/warming tiers, pre-joined with card_metrics prices
      db
        .from("public_variant_movers_priced")
        .select("canonical_slug, mover_tier, tier_priority, median_7d, provider_trend_slope_7d, updated_at")
        .eq("provider", "JUSTTCG")
        .eq("grade", "RAW")
        .in("mover_tier", ["hot", "warming"])
        .order("tier_priority", { ascending: true })
        .order("median_7d", { ascending: false })
        .limit(SECTION_LIMIT * 5),

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

    // ── Deduplicate movers by canonical_slug ──────────────────────────────
    type MoverRow = { canonical_slug: string; mover_tier: string; tier_priority: number; median_7d: number | null; provider_trend_slope_7d: number | null; updated_at: string };
    const dedupedMovers: MoverRow[] = [];
    const seenMovers = new Set<string>();
    for (const row of (moversResult.data ?? []) as MoverRow[]) {
      if (seenMovers.has(row.canonical_slug)) continue;
      seenMovers.add(row.canonical_slug);
      dedupedMovers.push(row);
      if (dedupedMovers.length >= SECTION_LIMIT) break; // view already filters to priced cards
    }

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
    for (const r of dedupedMovers) allSlugs.add(r.canonical_slug);
    for (const r of loserVariants) allSlugs.add(r.canonical_slug);
    for (const r of trendingVariants) allSlugs.add(r.canonical_slug);

    if (allSlugs.size === 0) return EMPTY;

    const slugArray = [...allSlugs];

    // ── Batch 2: card metadata + prices (with change pcts) + images ────
    const [cardsResult, marketPulseMap, imagesResult, sparklineResult] = await Promise.all([
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
    ]);

    if (cardsResult.error) console.error("[homepage] cards", cardsResult.error.message);
    if (imagesResult.error) console.error("[homepage] images", imagesResult.error.message);
    if (sparklineResult.error) console.error("[homepage] sparkline", sparklineResult.error.message);

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

    // ── Assemble helpers ──────────────────────────────────────────────────
    function toCard(
      slug: string,
      overrides: { fallbackPrice?: number | null; mover_tier?: HomepageCard["mover_tier"] } = {},
    ): HomepageCard {
      const card = cardMap.get(slug);
      const marketPulse = marketPulseMap.get(slug);
      return {
        slug,
        name: card?.canonical_name ?? slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        market_price: marketPulse?.marketPrice ?? overrides.fallbackPrice ?? null,
        change_pct: marketPulse?.changePct ?? null,
        change_window: marketPulse?.changeWindow ?? null,
        image_url: imageMap.get(slug) ?? null,
        mover_tier: overrides.mover_tier ?? null,
        sparkline_7d: sparklineMap.get(slug) ?? [],
      };
    }

    // ── Movers: view already guarantees price > 0 ─────────────────────────
    const moversOut: HomepageCard[] = [];
    for (const r of dedupedMovers) {
      const marketPulse = marketPulseMap.get(r.canonical_slug);
      // Movers are sourced from JustTCG; require a JustTCG price to avoid single-provider outliers.
      if (!marketPulse || marketPulse.justtcgPrice == null) continue;
      moversOut.push(toCard(r.canonical_slug, {
        fallbackPrice: r.median_7d,
        mover_tier: r.mover_tier as HomepageCard["mover_tier"],
      }));
    }
    moversOut.sort(compareMovementMagnitude);
    moversOut.splice(SECTION_LIMIT);

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

    return { movers: moversOut, losers: losersOut, trending: trendingOut, as_of };

  } catch (err) {
    console.error("[homepage] getHomepageData failed:", err);
    return EMPTY;
  }
}
