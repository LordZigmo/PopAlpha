import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { dbPublic } from "@/lib/db";
import { getCanonicalMarketPulseMap } from "@/lib/data/market";
import {
  computeAttributes,
  computeIdentity,
  computeComposition,
  computeDisplayAttributes,
  computeInsights,
  computeTopHoldings,
  computeRadarProfile,
  computeBadges,
  isGraded,
  lookupHoldingPrice,
} from "@/lib/data/portfolio";
import { normalizeHoldingGrade, type GradeBucket } from "@/lib/holdings/grade-normalize";
import { resolveCardImage } from "@/lib/images/resolve";

export const runtime = "nodejs";

/**
 * GET /api/portfolio/overview
 *
 * Returns the full enriched portfolio analysis: summary, collector identity,
 * composition, top holdings, attribute pills, and insights.
 *
 * Uses dbAdmin() because the iOS app sends a Clerk Bearer JWT that Supabase
 * RLS cannot validate. requireUser() verifies identity; every query filters
 * by owner_clerk_id.
 *
 * Returns a minimal response when the user has fewer than 3 holdings.
 */

type HoldingRow = {
  canonical_slug: string;
  qty: number;
  grade: string;
  price_paid_usd: number;
  printing_id: string | null;
};

type PrintingMetaRow = {
  id: string;
  finish: string | null;
  rarity: string | null;
  language: string | null;
};

type CardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  subject: string | null;
};

type ImageRow = {
  canonical_slug: string;
  image_url: string | null;
  mirrored_image_url: string | null;
  mirrored_thumb_url: string | null;
};

type PriceHistoryRow = {
  canonical_slug: string;
  ts: string;
  price: number;
};

type CardMetadata = {
  name: string;
  set_name: string | null;
  image_url: string | null;
  market_price: number | null;
  change_pct: number | null;
};

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const admin = dbAdmin();
    const pub = dbPublic();

    // 1. Fetch holdings
    const { data: holdingsData, error: holdingsErr } = await admin
      .from("holdings")
      .select("canonical_slug, qty, grade, price_paid_usd, printing_id")
      .eq("owner_clerk_id", auth.userId);

    if (holdingsErr) throw new Error(holdingsErr.message);
    const holdings = (holdingsData ?? []) as HoldingRow[];

    if (holdings.length === 0) {
      return NextResponse.json({ ok: true, minimal: true });
    }

    // 2. Collect unique slugs
    const slugs = [...new Set(holdings.map((h) => h.canonical_slug).filter(Boolean))];

    // 3. Parallel batch-fetch: market data + card metadata + images + price history + printing meta
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const printingIds = [...new Set(holdings.map((h) => h.printing_id).filter(Boolean))] as string[];
    const [pulseMap, cardsResult, imagesResult, historyResult, printingMetaResult] = await Promise.all([
      getCanonicalMarketPulseMap(pub, slugs, { includeJpPriceCoverage: true }),
      pub.from("canonical_cards")
        .select("slug, canonical_name, set_name, year, subject")
        .in("slug", slugs),
      pub.from("card_printings")
        .select("canonical_slug, image_url, mirrored_image_url, mirrored_thumb_url")
        .in("canonical_slug", slugs)
        .eq("language", "EN")
        .not("image_url", "is", null)
        .limit(slugs.length * 3),
      pub.from("public_price_history_canonical")
        .select("canonical_slug, ts, price")
        .in("canonical_slug", slugs)
        .not("variant_ref", "ilike", "%::GRADED::%")
        .eq("source_window", "snapshot")
        .eq("currency", "USD")
        .gte("ts", thirtyDaysAgo)
        .order("ts", { ascending: true })
        .limit(2000),
      printingIds.length > 0
        ? pub.from("card_printings")
            .select("id, finish, rarity, language")
            .in("id", printingIds)
        : Promise.resolve({ data: [] as PrintingMetaRow[], error: null }),
    ]);

    // LOUD degradation: every consumer below reads `.data ?? []`, so a
    // failed batch query silently degrades a feature with zero log
    // evidence — exactly how the portfolio chart vanished during the
    // 2026-06-12 statement-timeout storm (the price-history query timed
    // out → empty sparkline → chart hidden, nothing logged). Behavior
    // stays the same (each feature degrades independently rather than
    // failing the whole overview), but the degradation is now visible
    // in runtime logs and attributable to its query.
    const batchErrors: Array<[string, { error: { message: string } | null }]> = [
      ["canonical_cards", cardsResult],
      ["card_printings(images)", imagesResult],
      ["public_price_history_canonical(sparkline)", historyResult],
      ["card_printings(meta)", printingMetaResult],
    ];
    for (const [label, result] of batchErrors) {
      if (result.error) {
        console.error(
          `[portfolio/overview] batch query failed — degrading without ${label}: ${result.error.message}`,
        );
      }
    }

    // Build lookup maps
    const cardMap = new Map<string, CardRow>();
    for (const c of (cardsResult.data ?? []) as CardRow[]) {
      cardMap.set(c.slug, c);
    }

    const imageMap = new Map<string, string>();
    for (const img of (imagesResult.data ?? []) as ImageRow[]) {
      if (imageMap.has(img.canonical_slug)) continue;
      // Portfolio list rows display small thumbnails, so prefer the
      // mirrored thumb when available and fall back to the full URL.
      const resolved = resolveCardImage(img);
      const best = resolved.thumb ?? resolved.full;
      if (best) imageMap.set(img.canonical_slug, best);
    }

    const printingMetaMap = new Map<string, { finish: string | null; rarity: string | null; language: string | null }>();
    for (const p of (printingMetaResult.data ?? []) as PrintingMetaRow[]) {
      printingMetaMap.set(p.id, { finish: p.finish, rarity: p.rarity, language: p.language });
    }

    // slug-only RAW reference price — keeps powering the per-card sparkline
    // and cardMetadata (those are slug-level views, not per-holding).
    const slugRawPriceMap = new Map<string, number>();
    const changeMap = new Map<string, number>();
    for (const slug of slugs) {
      const pulse = pulseMap.get(slug);
      // Fall back through providers when market_price is null
      const price = pulse?.marketPrice
        ?? pulse?.scrydexPrice
        ?? pulse?.pokemontcgPrice
        ?? null;
      if (price != null) slugRawPriceMap.set(slug, price);
      const chg = pulse?.changePct24h ?? pulse?.changePct7d ?? 0;
      changeMap.set(slug, chg);
    }

    // priceMap is keyed by `${slug}::${bucket}` so per-holding valuation
    // (totalValue, computeAttributes/Composition/RadarProfile/TopHoldings)
    // picks up the right graded price. Seed with RAW from pulseMap, then
    // supplement with graded buckets for any (slug, bucket) pair that an
    // actual holding cares about — bounded by the user's 120-row holdings
    // limit, so the extra query is trivial in size.
    const priceMap = new Map<string, number>();
    for (const [slug, price] of slugRawPriceMap) {
      priceMap.set(`${slug}::RAW`, price);
    }

    const gradedBucketsNeeded = new Set<GradeBucket>();
    for (const h of holdings) {
      const bucket = normalizeHoldingGrade(h.grade);
      if (bucket !== "RAW") gradedBucketsNeeded.add(bucket);
    }
    if (gradedBucketsNeeded.size > 0) {
      const { data: gradedMetricRows, error: gradedMetricErr } = await pub
        .from("public_card_metrics")
        .select("canonical_slug, grade, market_price, median_7d, median_30d, trimmed_median_30d")
        .in("canonical_slug", slugs)
        .in("grade", [...gradedBucketsNeeded])
        .is("printing_id", null);
      if (gradedMetricErr) throw new Error(gradedMetricErr.message);
      for (const row of (gradedMetricRows ?? []) as Array<{
        canonical_slug: string;
        grade: string;
        market_price: number | null;
        median_7d: number | null;
        median_30d: number | null;
        trimmed_median_30d: number | null;
      }>) {
        // Graded canonical-level rows (printing_id IS NULL) consistently
        // have market_price = null — the refresh_card_metrics_for_variants
        // function only populates market_price for RAW. Walk a fallback
        // chain so graded holdings get valued from whatever signal the
        // metrics writer has produced:
        //
        //   median_7d        → freshest, but null on cards that haven't
        //                      traded in the last 7 days (~63% of graded
        //                      canonical rows fall through here)
        //   median_30d       → broader window; rescues ~55k additional
        //                      graded rows the 7d-only fallback missed
        //                      (G10 alone gains 13,801 priced rows)
        //   trimmed_median_30d → outlier-trimmed 30d for the long tail
        //
        // Without the deeper fallback, the majority of graded slabs in
        // user portfolios round to $0 in totals even though Scrydex has
        // emitted a recent rolling median for them.
        const price = row.market_price
          ?? row.median_7d
          ?? row.median_30d
          ?? row.trimmed_median_30d;
        if (price != null) priceMap.set(`${row.canonical_slug}::${row.grade}`, price);
      }
    }

    // Printing-scoped prices for holdings that pinned a specific finish.
    // Keyed `${slug}::${printing_id}::${bucket}` so lookupHoldingPrice values a
    // Reverse Holo / stamped / edition holding at its own price, falling back
    // to the canonical (printing-NULL) price when no per-printing metrics row
    // exists. Bounded by the user's 120-row holdings limit.
    const printingPriceIds = [...new Set(
      holdings.map((h) => h.printing_id).filter(Boolean) as string[],
    )];
    if (printingPriceIds.length > 0) {
      // Always include RAW: lookupHoldingPrice falls a graded finish-pinned
      // holding back to the printing's RAW price (tier 3) before canonical RAW,
      // so the printing's RAW row must be fetched even when no RAW lot is held.
      const printingBuckets = new Set<GradeBucket>(["RAW"]);
      for (const h of holdings) {
        if (h.printing_id) printingBuckets.add(normalizeHoldingGrade(h.grade));
      }
      const { data: printingMetricRows, error: printingMetricErr } = await pub
        .from("public_card_metrics")
        .select("canonical_slug, printing_id, grade, market_price, median_7d, median_30d, trimmed_median_30d")
        .in("canonical_slug", slugs)
        .in("printing_id", printingPriceIds)
        .in("grade", [...printingBuckets]);
      if (printingMetricErr) throw new Error(printingMetricErr.message);
      for (const row of (printingMetricRows ?? []) as Array<{
        canonical_slug: string;
        printing_id: string | null;
        grade: string;
        market_price: number | null;
        median_7d: number | null;
        median_30d: number | null;
        trimmed_median_30d: number | null;
      }>) {
        if (!row.printing_id) continue;
        // Same fallback chain as the graded canonical rows above: market_price
        // is populated for RAW, null for graded buckets (median_* carries those).
        const price = row.market_price
          ?? row.median_7d
          ?? row.median_30d
          ?? row.trimmed_median_30d;
        if (price != null) {
          priceMap.set(`${row.canonical_slug}::${row.printing_id}::${row.grade}`, price);
        }
      }
    }

    // Build per-slug card metadata for the iOS positions list
    const cardMetadata: Record<string, CardMetadata> = {};
    for (const slug of slugs) {
      const c = cardMap.get(slug);
      cardMetadata[slug] = {
        name: c?.canonical_name ?? slug,
        set_name: c?.set_name ?? null,
        image_url: imageMap.get(slug) ?? null,
        market_price: slugRawPriceMap.get(slug) ?? null,
        change_pct: changeMap.get(slug) ?? 0,
      };
    }

    // Compute portfolio value sparkline from RAW price history. The
    // sparkline backfills graded holdings' historical curve with their
    // slug's RAW price (price_history is RAW-only); a known approximation
    // for graded holders, bounded by Phase 4's eventual graded analytics.
    const sparkline = computeSparkline(
      (historyResult.data ?? []) as PriceHistoryRow[],
      holdings,
      slugRawPriceMap,
    );

    // 4. Compute summary
    let totalValue = 0;
    let totalCostBasis = 0;
    let cardCount = 0;
    let rawCount = 0;
    let gradedCount = 0;

    for (const h of holdings) {
      const qty = h.qty || 1;
      cardCount += qty;
      if (isGraded(h.grade)) gradedCount += qty; else rawCount += qty;

      const price = lookupHoldingPrice(priceMap, h.canonical_slug, h.grade, h.printing_id)
        ?? h.price_paid_usd;
      totalValue += price * qty;
      totalCostBasis += h.price_paid_usd * qty;
    }

    // Per-position prices so the iOS "Your Cards" list values, sorts, and
    // badges each position by its own finish+grade price instead of the
    // slug-level canonical price in card_metadata (which would disagree with
    // the printing-aware total above, and already showed RAW for graded). Keyed
    // `${slug}::${printing_id ?? ""}::${grade}` — the holding's raw grade string,
    // not the bucket — so the client builds the key from data it already has and
    // the server owns the bucket normalization inside lookupHoldingPrice.
    const positionPrices: Record<string, number> = {};
    for (const h of holdings) {
      const key = `${h.canonical_slug}::${h.printing_id ?? ""}::${h.grade}`;
      if (key in positionPrices) continue;
      const price = lookupHoldingPrice(priceMap, h.canonical_slug, h.grade, h.printing_id);
      if (price != null) positionPrices[key] = price;
    }

    const pnlAmount = totalValue - totalCostBasis;
    const pnlPct = totalCostBasis > 0 ? Math.round((pnlAmount / totalCostBasis) * 1000) / 10 : null;

    const summary = {
      total_value: Math.round(totalValue * 100) / 100,
      total_cost_basis: Math.round(totalCostBasis * 100) / 100,
      pnl_amount: Math.round(pnlAmount * 100) / 100,
      pnl_pct: pnlPct,
      card_count: cardCount,
      raw_count: rawCount,
      graded_count: gradedCount,
    };

    // 5. If fewer than 3 holdings, return summary only (not enough for analysis)
    if (holdings.length < 3) {
      return NextResponse.json({
        ok: true,
        minimal: true,
        summary,
        sparkline,
        card_metadata: cardMetadata,
        position_prices: positionPrices,
        top_holdings: computeTopHoldings(holdings, cardMap, priceMap, changeMap, imageMap),
      });
    }

    // 6. Full analysis
    const cardMetaMap = new Map(
      [...cardMap.entries()].map(([k, v]) => [k, { set_name: v.set_name, year: v.year }]),
    );
    // Radar/badges need the Pokémon `subject` for popular-character
    // detection (Charizard, Pikachu, Eeveelutions). Built separately so
    // the slimmer cardMetaMap above keeps powering attributes/composition.
    const radarCardMap = new Map(
      [...cardMap.entries()].map(([k, v]) => [k, { set_name: v.set_name, year: v.year, subject: v.subject }]),
    );

    const attrs = computeAttributes(holdings, cardMetaMap, priceMap);
    const identity = computeIdentity(attrs);
    const composition = computeComposition(holdings, cardMetaMap, priceMap);
    const displayAttrs = computeDisplayAttributes(attrs, cardCount);
    const insights = computeInsights(attrs, identity);
    const topHoldings = computeTopHoldings(holdings, cardMap, priceMap, changeMap, imageMap);
    const radarProfile = computeRadarProfile(holdings, radarCardMap, printingMetaMap, priceMap);
    const badges = computeBadges(holdings, radarCardMap, printingMetaMap, priceMap, radarProfile);

    return NextResponse.json({
      ok: true,
      minimal: false,
      summary,
      sparkline,
      card_metadata: cardMetadata,
      position_prices: positionPrices,
      identity,
      composition,
      top_holdings: topHoldings,
      attributes: displayAttrs,
      insights,
      radar_profile: radarProfile,
      badges,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[portfolio/overview] failed:", message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
}

/**
 * Build a 14-point portfolio value sparkline from raw price history.
 * Uses last-known-price-forward fill so the curve is continuous even on
 * days where some cards had no snapshots.
 */
function computeSparkline(
  history: PriceHistoryRow[],
  holdings: HoldingRow[],
  currentPrices: Map<string, number>,
): number[] {
  if (history.length === 0) return [];

  // Bucket prices by day, keeping the latest price per slug per day.
  const dayBuckets = new Map<string, Map<string, number>>();
  for (const row of history) {
    const day = row.ts.slice(0, 10);
    if (!dayBuckets.has(day)) dayBuckets.set(day, new Map());
    dayBuckets.get(day)!.set(row.canonical_slug, row.price);
  }

  const sortedDays = [...dayBuckets.keys()].sort();
  const lastKnown = new Map<string, number>();

  // Seed with cost basis so brand-new cards still contribute before they
  // appear in the price history.
  for (const h of holdings) {
    lastKnown.set(h.canonical_slug, h.price_paid_usd);
  }

  const series: number[] = [];
  for (const day of sortedDays) {
    for (const [slug, price] of dayBuckets.get(day)!) {
      lastKnown.set(slug, price);
    }
    let val = 0;
    for (const h of holdings) {
      const p = lastKnown.get(h.canonical_slug) ?? h.price_paid_usd;
      val += p * (h.qty || 1);
    }
    series.push(Math.round(val * 100) / 100);
  }

  // Append a final point using the latest current prices so the line ends
  // at "today's value" rather than the last snapshot day.
  let nowVal = 0;
  for (const h of holdings) {
    const p = currentPrices.get(h.canonical_slug) ?? lastKnown.get(h.canonical_slug) ?? h.price_paid_usd;
    nowVal += p * (h.qty || 1);
  }
  series.push(Math.round(nowVal * 100) / 100);

  // Down-sample to 14 points if we have many.
  if (series.length > 14) {
    const step = (series.length - 1) / 13;
    const sampled: number[] = [];
    for (let i = 0; i < 14; i++) {
      sampled.push(series[Math.round(i * step)]!);
    }
    return sampled;
  }
  return series;
}
