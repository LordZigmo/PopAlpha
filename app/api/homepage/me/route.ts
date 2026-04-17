import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require";
import {
  getCanonicalMarketPulseMap,
  resolveCanonicalMarketPulse,
} from "@/lib/data/market";
import type { MarketDirection } from "@/lib/data/market-strength";
import { dbPublic } from "@/lib/db";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import { resolveCardImage } from "@/lib/images/resolve";

/**
 * GET /api/homepage/me — personalized homepage data for the signed-in user.
 *
 * Returns:
 *   - watchlist_movers: top 5 watchlisted cards ranked by absolute 24H change%
 *   - portfolio:        total market value, cost basis, daily P&L (amount + pct)
 *
 * Returns 401 for unauthenticated requests. Logged-out iOS clients should
 * skip this call entirely (the homepage renders a signup CTA instead).
 *
 * Uses requireUser() (not requireOnboarded()) so users who have signed in
 * but haven't picked a handle yet still see personalized data.
 */

export const runtime = "nodejs";

type WatchlistMover = {
  slug: string;
  name: string;
  set_name: string | null;
  year: number | null;
  market_price: number | null;
  change_pct: number | null;
  change_window: string | null;
  image_url: string | null;
  image_thumb_url: string | null;
  market_direction: MarketDirection | null;
};

type PortfolioSummary = {
  total_market_value: number;
  total_cost_basis: number;
  daily_pnl_amount: number;
  daily_pnl_pct: number | null;
  holding_count: number;
};

const WATCHLIST_MOVER_LIMIT = 5;

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const userDb = await createServerSupabaseUserClient();
  const publicDb = dbPublic();

  try {
    // Fetch watchlist slugs and holdings in parallel.
    const [wishlistResult, holdingsResult] = await Promise.all([
      userDb
        .from("wishlist_items")
        .select("canonical_slug")
        .eq("owner_id", auth.userId)
        .order("created_at", { ascending: false })
        .limit(50),
      userDb
        .from("holdings")
        .select("canonical_slug, qty, price_paid_usd")
        .eq("owner_clerk_id", auth.userId),
    ]);

    if (wishlistResult.error) {
      console.error("[homepage/me] wishlist", wishlistResult.error.message);
    }
    if (holdingsResult.error) {
      console.error("[homepage/me] holdings", holdingsResult.error.message);
    }

    const wishlistSlugs = (wishlistResult.data ?? []).map(
      (r: { canonical_slug: string }) => r.canonical_slug,
    );
    const holdingsRows = (holdingsResult.data ?? []) as Array<{
      canonical_slug: string;
      qty: number;
      price_paid_usd: number | null;
    }>;

    // Collect all slugs we need market data for (deduplicated).
    const allSlugs = new Set<string>();
    for (const s of wishlistSlugs) allSlugs.add(s);
    for (const h of holdingsRows) allSlugs.add(h.canonical_slug);

    // Fetch card metadata + market pulse for all slugs in one batch.
    const slugArray = [...allSlugs];

    const [pulseMap, cardsResult, imagesResult] = await Promise.all([
      slugArray.length > 0
        ? getCanonicalMarketPulseMap(publicDb, slugArray)
        : Promise.resolve(new Map()),
      slugArray.length > 0
        ? publicDb
            .from("canonical_cards")
            .select("slug, canonical_name, set_name, year")
            .in("slug", slugArray)
        : Promise.resolve({ data: [], error: null }),
      slugArray.length > 0
        ? publicDb
            .from("card_printings")
            .select("canonical_slug, image_url, mirrored_image_url, mirrored_thumb_url")
            .in("canonical_slug", slugArray)
            .eq("language", "EN")
            .not("image_url", "is", null)
            .limit(slugArray.length)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const cardMap = new Map<
      string,
      { canonical_name: string; set_name: string | null; year: number | null }
    >();
    for (const c of (cardsResult.data ?? []) as Array<{
      slug: string;
      canonical_name: string;
      set_name: string | null;
      year: number | null;
    }>) {
      cardMap.set(c.slug, c);
    }

    const imageMap = new Map<string, { full: string | null; thumb: string | null }>();
    for (const img of (imagesResult.data ?? []) as Array<{
      canonical_slug: string;
      image_url: string | null;
      mirrored_image_url: string | null;
      mirrored_thumb_url: string | null;
    }>) {
      if (imageMap.has(img.canonical_slug)) continue;
      const resolved = resolveCardImage(img);
      if (resolved.full || resolved.thumb) {
        imageMap.set(img.canonical_slug, resolved);
      }
    }

    // ── Watchlist movers ──────────────────────────────────────────────────
    const watchlistMovers: WatchlistMover[] = wishlistSlugs
      .map((slug: string) => {
        const pulse = pulseMap.get(slug);
        const card = cardMap.get(slug);
        if (!pulse) return null;
        const changePct = pulse.changePct24h ?? pulse.changePct7d ?? null;
        const changeWindow =
          pulse.changePct24h != null
            ? "24H"
            : pulse.changePct7d != null
              ? "7D"
              : null;
        return {
          slug,
          name: card?.canonical_name ?? slug,
          set_name: card?.set_name ?? null,
          year: card?.year ?? null,
          market_price: pulse.marketPrice,
          change_pct: changePct,
          change_window: changeWindow,
          image_url: imageMap.get(slug)?.full ?? null,
          image_thumb_url: imageMap.get(slug)?.thumb ?? null,
          market_direction: pulse.marketDirection ?? null,
        };
      })
      .filter((m: WatchlistMover | null): m is WatchlistMover => m !== null)
      .sort(
        (a: WatchlistMover, b: WatchlistMover) =>
          Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0),
      )
      .slice(0, WATCHLIST_MOVER_LIMIT);

    // ── Portfolio summary ─────────────────────────────────────────────────
    let portfolio: PortfolioSummary | null = null;

    if (holdingsRows.length > 0) {
      let totalMarketValue = 0;
      let totalCostBasis = 0;
      let holdingCount = 0;

      for (const h of holdingsRows) {
        const qty = Number(h.qty) || 0;
        if (qty <= 0) continue;
        holdingCount += qty;

        const costBasis = Number(h.price_paid_usd ?? 0) * qty;
        totalCostBasis += costBasis;

        const pulse = pulseMap.get(h.canonical_slug);
        const marketPrice = pulse?.marketPrice ?? null;
        if (marketPrice != null && marketPrice > 0) {
          totalMarketValue += marketPrice * qty;
        } else {
          // If no market price, use cost basis as fallback so the total
          // isn't misleadingly deflated.
          totalMarketValue += costBasis;
        }
      }

      const pnlAmount = totalMarketValue - totalCostBasis;
      const pnlPct =
        totalCostBasis > 0
          ? Math.round((pnlAmount / totalCostBasis) * 1000) / 10
          : null;

      portfolio = {
        total_market_value: Math.round(totalMarketValue * 100) / 100,
        total_cost_basis: Math.round(totalCostBasis * 100) / 100,
        daily_pnl_amount: Math.round(pnlAmount * 100) / 100,
        daily_pnl_pct: pnlPct,
        holding_count: holdingCount,
      };
    }

    return NextResponse.json({
      ok: true,
      watchlist_movers: watchlistMovers,
      portfolio,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[homepage/me] failed:", message);
    return NextResponse.json(
      { ok: false, error: "Internal error." },
      { status: 500 },
    );
  }
}
