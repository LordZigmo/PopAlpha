import MarketSummaryCardClient from "@/components/market-summary-card-client";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type MarketSummaryCardProps = {
  canonicalSlug: string;
  printingId: string | null;
  variantRef: string | null;
  selectedWindow: "7d" | "30d" | "90d";
};

type MarketLatestRow = {
  price_usd: number | null;
  observed_at: string | null;
  updated_at: string | null;
};

type HistoryPointRow = {
  ts: string;
  price: number;
};

function filterRecentDays(points: HistoryPointRow[], days: number): HistoryPointRow[] {
  if (points.length === 0) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((point) => {
    const ts = new Date(point.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

export default async function MarketSummaryCard({
  canonicalSlug,
  printingId,
  variantRef,
  selectedWindow,
}: MarketSummaryCardProps) {
  const supabase = getServerSupabaseClient();

  const [marketLatestQuery, history7dQuery, history30dQuery, history90dQuery] = printingId && variantRef
    ? await Promise.all([
        supabase
          .from("market_latest")
          .select("price_usd, observed_at, updated_at")
          .eq("canonical_slug", canonicalSlug)
          .eq("printing_id", printingId)
          .eq("source", "JUSTTCG")
          .eq("grade", "RAW")
          .eq("price_type", "MARKET")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle<MarketLatestRow>(),
        supabase
          .from("price_history_points")
          .select("ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "7d")
          .eq("variant_ref", variantRef)
          .order("ts", { ascending: false })
          .limit(120),
        supabase
          .from("price_history_points")
          .select("ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "30d")
          .eq("variant_ref", variantRef)
          .order("ts", { ascending: false })
          .limit(200),
        supabase
          .from("price_history_points")
          .select("ts, price")
          .eq("canonical_slug", canonicalSlug)
          .eq("provider", "JUSTTCG")
          .eq("source_window", "90d")
          .eq("variant_ref", variantRef)
          .order("ts", { ascending: false })
          .limit(400),
      ])
    : [
        { data: null },
        { data: [] as HistoryPointRow[] },
        { data: [] as HistoryPointRow[] },
        { data: [] as HistoryPointRow[] },
      ];

  const marketLatest = marketLatestQuery.data ?? null;
  const cachedHistory7d = [...(((history7dQuery.data ?? []) as HistoryPointRow[]))].reverse();
  const history30d = [...(((history30dQuery.data ?? []) as HistoryPointRow[]))].reverse();
  const history90d = [...(((history90dQuery.data ?? []) as HistoryPointRow[]))].reverse();
  const history7d = cachedHistory7d.length > 0 ? cachedHistory7d : filterRecentDays(history30d, 7);
  const asOfTs = marketLatest?.observed_at ?? marketLatest?.updated_at ?? null;

  return (
    <MarketSummaryCardClient
      currentPrice={marketLatest?.price_usd ?? null}
      asOfTs={asOfTs}
      selectedWindow={selectedWindow}
      history7d={history7d}
      history30d={history30d}
      history90d={history90d}
    />
  );
}
