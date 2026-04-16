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
  isGraded,
} from "@/lib/data/portfolio";

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
};

type CardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
};

type ImageRow = {
  canonical_slug: string;
  image_url: string | null;
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
      .select("canonical_slug, qty, grade, price_paid_usd")
      .eq("owner_clerk_id", auth.userId);

    if (holdingsErr) throw new Error(holdingsErr.message);
    const holdings = (holdingsData ?? []) as HoldingRow[];

    if (holdings.length === 0) {
      return NextResponse.json({ ok: true, minimal: true });
    }

    // 2. Collect unique slugs
    const slugs = [...new Set(holdings.map((h) => h.canonical_slug).filter(Boolean))];

    // 3. Parallel batch-fetch: market data + card metadata + images + price history
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const [pulseMap, cardsResult, imagesResult, historyResult] = await Promise.all([
      getCanonicalMarketPulseMap(pub, slugs),
      pub.from("canonical_cards")
        .select("slug, canonical_name, set_name, year")
        .in("slug", slugs),
      pub.from("card_printings")
        .select("canonical_slug, image_url")
        .in("canonical_slug", slugs)
        .eq("language", "EN")
        .not("image_url", "is", null)
        .limit(slugs.length * 3),
      pub.from("public_price_history_canonical")
        .select("canonical_slug, ts, price")
        .in("canonical_slug", slugs)
        .eq("source_window", "snapshot")
        .gte("ts", thirtyDaysAgo)
        .order("ts", { ascending: true })
        .limit(2000),
    ]);

    // Build lookup maps
    const cardMap = new Map<string, CardRow>();
    for (const c of (cardsResult.data ?? []) as CardRow[]) {
      cardMap.set(c.slug, c);
    }

    const imageMap = new Map<string, string>();
    for (const img of (imagesResult.data ?? []) as ImageRow[]) {
      if (img.image_url && !imageMap.has(img.canonical_slug)) {
        imageMap.set(img.canonical_slug, img.image_url);
      }
    }

    const priceMap = new Map<string, number>();
    const changeMap = new Map<string, number>();
    for (const slug of slugs) {
      const pulse = pulseMap.get(slug);
      // Fall back through providers when market_price is null
      const price = pulse?.marketPrice
        ?? pulse?.scrydexPrice
        ?? pulse?.justtcgPrice
        ?? pulse?.pokemontcgPrice
        ?? null;
      if (price != null) priceMap.set(slug, price);
      const chg = pulse?.changePct24h ?? pulse?.changePct7d ?? 0;
      changeMap.set(slug, chg);
    }

    // Build per-slug card metadata for the iOS positions list
    const cardMetadata: Record<string, CardMetadata> = {};
    for (const slug of slugs) {
      const c = cardMap.get(slug);
      cardMetadata[slug] = {
        name: c?.canonical_name ?? slug,
        set_name: c?.set_name ?? null,
        image_url: imageMap.get(slug) ?? null,
        market_price: priceMap.get(slug) ?? null,
        change_pct: changeMap.get(slug) ?? 0,
      };
    }

    // Compute portfolio value sparkline from price history.
    // For each day we have data, sum (price × qty) using last-known prices.
    const sparkline = computeSparkline(
      (historyResult.data ?? []) as PriceHistoryRow[],
      holdings,
      priceMap,
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

      const price = priceMap.get(h.canonical_slug) ?? h.price_paid_usd;
      totalValue += price * qty;
      totalCostBasis += h.price_paid_usd * qty;
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
        top_holdings: computeTopHoldings(holdings, cardMap, priceMap, changeMap, imageMap),
      });
    }

    // 6. Full analysis
    const cardMetaMap = new Map(
      [...cardMap.entries()].map(([k, v]) => [k, { set_name: v.set_name, year: v.year }]),
    );

    const attrs = computeAttributes(holdings, cardMetaMap, priceMap);
    const identity = computeIdentity(attrs);
    const composition = computeComposition(holdings, cardMetaMap, priceMap);
    const displayAttrs = computeDisplayAttributes(attrs, cardCount);
    const insights = computeInsights(attrs, identity);
    const topHoldings = computeTopHoldings(holdings, cardMap, priceMap, changeMap, imageMap);

    return NextResponse.json({
      ok: true,
      minimal: false,
      summary,
      sparkline,
      card_metadata: cardMetadata,
      identity,
      composition,
      top_holdings: topHoldings,
      attributes: displayAttrs,
      insights,
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
