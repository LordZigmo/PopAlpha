import { dbPublic } from "@/lib/db";

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
