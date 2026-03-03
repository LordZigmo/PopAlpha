/**
 * lib/data/homepage.ts
 *
 * Single server-side data loader for the homepage.
 * Uses dbPublic() only — no service-role access.
 *
 * Query plan (2 parallel batches, 4 queries total):
 *   Batch 1: movers (variant_movers) + variant metrics for losers/trending (parallel)
 *   Batch 2: canonical_cards metadata + card_metrics prices (parallel)
 *   JS merge into HomepageData
 *
 * Why two tables?
 *   - variant_metrics has provider_trend_slope_7d (for losers/trending)
 *   - card_metrics has median_7d prices (for display)
 *   - refresh_card_metrics() doesn't copy trend data to canonical rows
 */

import { dbPublic } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export type HomepageCard = {
  slug: string;
  name: string;
  set_name: string | null;
  year: number | null;
  median_7d: number | null;
  trend_slope_7d: number | null;
  mover_tier: "hot" | "warming" | "cooling" | "cold" | null;
  image_url: string | null;
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

    // ── Batch 2: card metadata + prices + images ──────────────────────────
    const [cardsResult, pricesResult, imagesResult] = await Promise.all([
      db
        .from("canonical_cards")
        .select("slug, canonical_name, set_name, year")
        .in("slug", slugArray),

      db
        .from("public_card_metrics")
        .select("canonical_slug, median_7d")
        .in("canonical_slug", slugArray)
        .is("printing_id", null)
        .eq("grade", "RAW"),

      db
        .from("card_printings")
        .select("canonical_slug, image_url")
        .in("canonical_slug", slugArray)
        .eq("language", "EN")
        .not("image_url", "is", null)
        .limit(slugArray.length * 3),
    ]);

    if (cardsResult.error) console.error("[homepage] cards", cardsResult.error.message);
    if (pricesResult.error) console.error("[homepage] prices", pricesResult.error.message);
    if (imagesResult.error) console.error("[homepage] images", imagesResult.error.message);

    // ── Build lookup maps ─────────────────────────────────────────────────
    type CardRow = { slug: string; canonical_name: string; set_name: string | null; year: number | null };
    const cardMap = new Map<string, CardRow>();
    for (const c of (cardsResult.data ?? []) as CardRow[]) {
      cardMap.set(c.slug, c);
    }

    const priceMap = new Map<string, number | null>();
    for (const row of (pricesResult.data ?? []) as { canonical_slug: string; median_7d: number | null }[]) {
      if (!priceMap.has(row.canonical_slug)) {
        priceMap.set(row.canonical_slug, row.median_7d);
      }
    }

    const imageMap = new Map<string, string>();
    for (const row of (imagesResult.data ?? []) as { canonical_slug: string; image_url: string }[]) {
      if (!imageMap.has(row.canonical_slug) && row.image_url) {
        imageMap.set(row.canonical_slug, row.image_url);
      }
    }

    // ── Assemble helpers ──────────────────────────────────────────────────
    function toCard(
      slug: string,
      overrides: { median_7d?: number | null; trend_slope_7d?: number | null; mover_tier?: HomepageCard["mover_tier"] } = {},
    ): HomepageCard {
      const card = cardMap.get(slug);
      const price = overrides.median_7d ?? priceMap.get(slug) ?? null;
      return {
        slug,
        name: card?.canonical_name ?? slug,
        set_name: card?.set_name ?? null,
        year: card?.year ?? null,
        median_7d: price,
        image_url: imageMap.get(slug) ?? null,
        trend_slope_7d: overrides.trend_slope_7d ?? null,
        mover_tier: overrides.mover_tier ?? null,
      };
    }

    function hasPrice(slug: string): boolean {
      const p = priceMap.get(slug);
      return p != null && p > 0;
    }

    // ── Movers: view already guarantees price > 0 ─────────────────────────
    const moversOut: HomepageCard[] = [];
    for (const r of dedupedMovers) {
      moversOut.push(toCard(r.canonical_slug, {
        median_7d: r.median_7d,
        trend_slope_7d: r.provider_trend_slope_7d,
        mover_tier: r.mover_tier as HomepageCard["mover_tier"],
      }));
      if (moversOut.length >= SECTION_LIMIT) break;
    }

    // ── Losers: filter to cards with real prices above MIN_PRICE ─────────
    const losersOut: HomepageCard[] = [];
    for (const r of loserVariants) {
      const price = priceMap.get(r.canonical_slug);
      if (price == null || price < MIN_PRICE) continue;
      losersOut.push(toCard(r.canonical_slug, {
        trend_slope_7d: r.provider_trend_slope_7d,
      }));
      if (losersOut.length >= SECTION_LIMIT) break;
    }

    // ── Trending: filter to cards with real prices above MIN_PRICE ────────
    const trendingOut: HomepageCard[] = [];
    for (const r of trendingVariants) {
      const price = priceMap.get(r.canonical_slug);
      if (price == null || price < MIN_PRICE) continue;
      trendingOut.push(toCard(r.canonical_slug, {
        trend_slope_7d: r.provider_trend_slope_7d,
      }));
      if (trendingOut.length >= SECTION_LIMIT) break;
    }

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
