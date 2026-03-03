/**
 * lib/data/homepage.ts
 *
 * Single server-side data loader for the homepage.
 * Uses dbPublic() only — no service-role access.
 *
 * Query plan (2 parallel batches, no N+1):
 *   Batch 1: movers, losers, trending (parallel)
 *   Batch 2: canonical_cards metadata + mover prices (parallel)
 *   JS merge into HomepageData
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
};

export type HomepageData = {
  movers: HomepageCard[];
  losers: HomepageCard[];
  trending: HomepageCard[];
  as_of: string | null;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SECTION_LIMIT = 12;
/** Minimum 7d median to filter noise / $0 cards */
const MIN_PRICE = 1;
/** Minimum trade count for "sustained trending" vs noise */
const MIN_CHANGES_TRENDING = 5;

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
  // ── Batch 1: three independent queries in parallel ──────────────────────
  const [moversResult, losersResult, trendingResult] = await Promise.all([
    // 1. Top movers — hot/warming tiers from public_variant_movers
    db
      .from("public_variant_movers")
      .select("canonical_slug, mover_tier, tier_priority, updated_at")
      .eq("provider", "JUSTTCG")
      .eq("grade", "RAW")
      .in("mover_tier", ["hot", "warming"])
      .order("tier_priority", { ascending: true })
      .order("updated_at", { ascending: false })
      .limit(SECTION_LIMIT * 5),

    // 2. Top losers — steepest negative trend slope
    db
      .from("public_card_metrics")
      .select("canonical_slug, median_7d, provider_trend_slope_7d, updated_at")
      .is("printing_id", null)
      .eq("grade", "RAW")
      .lt("provider_trend_slope_7d", 0)
      .gt("median_7d", MIN_PRICE)
      .order("provider_trend_slope_7d", { ascending: true })
      .limit(SECTION_LIMIT),

    // 3. Trending — positive sustained momentum (slope > 0 + enough activity)
    db
      .from("public_card_metrics")
      .select("canonical_slug, median_7d, provider_trend_slope_7d, provider_price_changes_count_30d, updated_at")
      .is("printing_id", null)
      .eq("grade", "RAW")
      .gt("provider_trend_slope_7d", 0)
      .gt("median_7d", MIN_PRICE)
      .gte("provider_price_changes_count_30d", MIN_CHANGES_TRENDING)
      .order("provider_trend_slope_7d", { ascending: false })
      .limit(SECTION_LIMIT),
  ]);

  if (moversResult.error) console.error("[homepage] movers", moversResult.error.message);
  if (losersResult.error) console.error("[homepage] losers", losersResult.error.message);
  if (trendingResult.error) console.error("[homepage] trending", trendingResult.error.message);

  // ── Deduplicate movers by canonical_slug ────────────────────────────────
  type MoverRow = { canonical_slug: string; mover_tier: string; tier_priority: number; updated_at: string };
  const dedupedMovers: MoverRow[] = [];
  const seenMovers = new Set<string>();
  for (const row of (moversResult.data ?? []) as MoverRow[]) {
    if (seenMovers.has(row.canonical_slug)) continue;
    seenMovers.add(row.canonical_slug);
    dedupedMovers.push(row);
    if (dedupedMovers.length >= SECTION_LIMIT) break;
  }

  type MetricsRow = { canonical_slug: string; median_7d: number | null; provider_trend_slope_7d: number | null };
  const losers = (losersResult.data ?? []) as MetricsRow[];
  const trending = (trendingResult.data ?? []) as MetricsRow[];

  // ── Collect all unique slugs for batch metadata fetch ───────────────────
  const allSlugs = new Set<string>();
  const moverSlugs: string[] = [];
  for (const r of dedupedMovers) { allSlugs.add(r.canonical_slug); moverSlugs.push(r.canonical_slug); }
  for (const r of losers) allSlugs.add(r.canonical_slug);
  for (const r of trending) allSlugs.add(r.canonical_slug);

  if (allSlugs.size === 0) {
    return { movers: [], losers: [], trending: [], as_of: null };
  }

  const slugArray = [...allSlugs];

  // ── Batch 2: card names + mover prices in parallel ─────────────────────
  const [cardsResult, moverMetricsResult] = await Promise.all([
    db
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year")
      .in("slug", slugArray),

    moverSlugs.length > 0
      ? db
          .from("public_card_metrics")
          .select("canonical_slug, median_7d, provider_trend_slope_7d")
          .in("canonical_slug", moverSlugs)
          .is("printing_id", null)
          .eq("grade", "RAW")
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (cardsResult.error) console.error("[homepage] cards", cardsResult.error.message);
  if (moverMetricsResult.error) console.error("[homepage] moverMetrics", moverMetricsResult.error.message);

  // ── Build lookup maps ──────────────────────────────────────────────────
  type CardRow = { slug: string; canonical_name: string; set_name: string | null; year: number | null };
  const cardMap = new Map<string, CardRow>();
  for (const c of (cardsResult.data ?? []) as CardRow[]) {
    cardMap.set(c.slug, c);
  }

  // Mover prices (deduplicate to first per slug — already ordered by updated_at desc)
  const moverPriceMap = new Map<string, { median_7d: number | null; provider_trend_slope_7d: number | null }>();
  for (const row of (moverMetricsResult.data ?? []) as MetricsRow[]) {
    if (!moverPriceMap.has(row.canonical_slug)) {
      moverPriceMap.set(row.canonical_slug, {
        median_7d: row.median_7d,
        provider_trend_slope_7d: row.provider_trend_slope_7d,
      });
    }
  }

  // ── Assemble final arrays ──────────────────────────────────────────────
  function toCard(
    slug: string,
    overrides: { median_7d?: number | null; trend_slope_7d?: number | null; mover_tier?: HomepageCard["mover_tier"] } = {},
  ): HomepageCard {
    const card = cardMap.get(slug);
    return {
      slug,
      name: card?.canonical_name ?? slug,
      set_name: card?.set_name ?? null,
      year: card?.year ?? null,
      median_7d: overrides.median_7d ?? null,
      trend_slope_7d: overrides.trend_slope_7d ?? null,
      mover_tier: overrides.mover_tier ?? null,
    };
  }

  const moversOut = dedupedMovers.map((r) => {
    const prices = moverPriceMap.get(r.canonical_slug);
    return toCard(r.canonical_slug, {
      median_7d: prices?.median_7d,
      trend_slope_7d: prices?.provider_trend_slope_7d,
      mover_tier: r.mover_tier as HomepageCard["mover_tier"],
    });
  });

  const losersOut = losers.map((r) =>
    toCard(r.canonical_slug, {
      median_7d: r.median_7d,
      trend_slope_7d: r.provider_trend_slope_7d,
    }),
  );

  const trendingOut = trending.map((r) =>
    toCard(r.canonical_slug, {
      median_7d: r.median_7d,
      trend_slope_7d: r.provider_trend_slope_7d,
    }),
  );

  // Derive as_of from the most recent updated_at across all data
  const timestamps = [
    ...(moversResult.data ?? []).map((r: { updated_at?: string }) => r.updated_at),
    ...(losersResult.data ?? []).map((r: { updated_at?: string }) => r.updated_at),
    ...(trendingResult.data ?? []).map((r: { updated_at?: string }) => r.updated_at),
  ].filter(Boolean) as string[];
  const as_of = timestamps.length > 0 ? timestamps.sort().reverse()[0] : null;

  return { movers: moversOut, losers: losersOut, trending: trendingOut, as_of };

  } catch (err) {
    console.error("[homepage] getHomepageData failed:", err);
    return EMPTY;
  }
}
