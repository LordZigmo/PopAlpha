import { dbPublic } from "@/lib/db";
import type { HomepageCard } from "@/lib/data/homepage";
import { getCanonicalMarketPulseMap } from "@/lib/data/market";

export type CardViewPoint = {
  date: string;
  views: number;
};

type CardViewDailyRow = {
  view_date: string;
  views: number | null;
};

type CardViewTotalRow = {
  total_views: number | null;
};

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getCardViewSnapshot(
  canonicalSlug: string,
  days = 14,
): Promise<{ totalViews: number; series: CardViewPoint[] }> {
  const supabase = dbPublic();
  const safeDays = Math.max(1, Math.min(days, 90));

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (safeDays - 1));

  const [dailyQuery, totalQuery] = await Promise.all([
    supabase
      .from("public_card_page_view_daily")
      .select("view_date, views")
      .eq("canonical_slug", canonicalSlug)
      .gte("view_date", formatUtcDate(start))
      .order("view_date", { ascending: true }),
    supabase
      .from("public_card_page_view_totals")
      .select("total_views")
      .eq("canonical_slug", canonicalSlug)
      .maybeSingle<CardViewTotalRow>(),
  ]);

  const counts = new Map<string, number>();
  for (const row of (dailyQuery.data ?? []) as CardViewDailyRow[]) {
    if (!row.view_date) continue;
    counts.set(row.view_date, Number(row.views ?? 0));
  }

  const series: CardViewPoint[] = [];
  for (let index = 0; index < safeDays; index += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    const key = formatUtcDate(day);
    series.push({
      date: key,
      views: counts.get(key) ?? 0,
    });
  }

  return {
    totalViews: Number(totalQuery.data?.total_views ?? 0),
    series,
  };
}

type TopViewedDailyRow = {
  canonical_slug: string;
  views: number | null;
};

type TopViewedCardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  primary_image_url: string | null;
};

export async function getTopViewedCards(days = 7, limit = 5): Promise<HomepageCard[]> {
  const supabase = dbPublic();
  const safeDays = Math.max(1, Math.min(days, 30));
  const safeLimit = Math.max(1, Math.min(limit, 12));

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (safeDays - 1));

  const { data: dailyRows, error } = await supabase
    .from("public_card_page_view_daily")
    .select("canonical_slug, views")
    .gte("view_date", formatUtcDate(start))
    .limit(Math.max(safeLimit * 20, 100));

  if (error) {
    console.error("[card-views] top viewed", error.message);
    return [];
  }

  const totals = new Map<string, number>();
  for (const row of (dailyRows ?? []) as TopViewedDailyRow[]) {
    if (!row.canonical_slug) continue;
    totals.set(row.canonical_slug, (totals.get(row.canonical_slug) ?? 0) + Number(row.views ?? 0));
  }

  const rankedSlugs = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit * 3)
    .map(([slug]) => slug);

  if (rankedSlugs.length === 0) return [];

  const [{ data: cards, error: cardsError }, marketMap] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, primary_image_url")
      .in("slug", rankedSlugs),
    getCanonicalMarketPulseMap(supabase, rankedSlugs),
  ]);

  if (cardsError) {
    console.error("[card-views] top viewed cards", cardsError.message);
    return [];
  }

  const cardMap = new Map(
    ((cards ?? []) as TopViewedCardRow[]).map((row) => [row.slug, row] as const),
  );

  const topViewedCards = rankedSlugs
    .map((slug) => {
      const card = cardMap.get(slug);
      if (!card) return null;
      const market = marketMap.get(slug);
      const result: HomepageCard = {
        slug,
        name: card.canonical_name,
        set_name: card.set_name,
        year: card.year,
        market_price: market?.marketPrice ?? null,
        change_pct: market?.changePct ?? null,
        change_window: market?.changeWindow ?? null,
        mover_tier: null,
        image_url: card.primary_image_url ?? null,
        sparkline_7d: [],
      };
      return result;
    })
    .filter((card): card is HomepageCard => card !== null)
    .slice(0, safeLimit);

  return topViewedCards;
}
