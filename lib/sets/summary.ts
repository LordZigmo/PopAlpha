import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { buildSetId } from "@/lib/sets/summary-core.mjs";

type SetSummarySnapshotRow = {
  set_id: string;
  set_name: string;
  as_of_date: string;
  market_cap: number;
  market_cap_all_variants: number | null;
  change_7d_pct: number | null;
  change_30d_pct: number | null;
  heat_score: number;
  breakout_count: number;
  value_zone_count: number;
  trend_bullish_count: number;
  sentiment_up_pct: number | null;
  vote_count: number;
  top_movers_json: Array<SetSummaryMover>;
  top_losers_json: Array<SetSummaryMover>;
  updated_at: string;
};

type SetFinishSummaryRow = {
  set_id: string;
  set_name: string;
  finish: string;
  market_cap: number;
  card_count: number;
  change_7d_pct: number | null;
  change_30d_pct: number | null;
  updated_at: string;
};

export type SetSummaryMover = {
  canonical_slug: string;
  variant_ref: string;
  price: number;
  change_7d_pct: number | null;
  finish: string | null;
};

export type SetSummarySnapshot = {
  setId: string;
  setName: string;
  asOfDate: string;
  marketCap: number;
  marketCapAllVariants: number | null;
  change7dPct: number | null;
  change30dPct: number | null;
  heatScore: number;
  breakoutCount: number;
  valueZoneCount: number;
  trendBullishCount: number;
  sentimentUpPct: number | null;
  voteCount: number;
  topMovers: SetSummaryMover[];
  topLosers: SetSummaryMover[];
  updatedAt: string;
};

export type SetFinishBreakdown = {
  setId: string;
  setName: string;
  finish: string;
  marketCap: number;
  cardCount: number;
  change7dPct: number | null;
  change30dPct: number | null;
  updatedAt: string;
};

export type SetSummaryPageData = {
  setId: string;
  snapshot: SetSummarySnapshot | null;
  finishBreakdown: SetFinishBreakdown[];
};

function toSnapshot(row: SetSummarySnapshotRow): SetSummarySnapshot {
  return {
    setId: row.set_id,
    setName: row.set_name,
    asOfDate: row.as_of_date,
    marketCap: Number(row.market_cap ?? 0),
    marketCapAllVariants:
      row.market_cap_all_variants === null || row.market_cap_all_variants === undefined
        ? null
        : Number(row.market_cap_all_variants),
    change7dPct: row.change_7d_pct === null ? null : Number(row.change_7d_pct),
    change30dPct: row.change_30d_pct === null ? null : Number(row.change_30d_pct),
    heatScore: Number(row.heat_score ?? 0),
    breakoutCount: Number(row.breakout_count ?? 0),
    valueZoneCount: Number(row.value_zone_count ?? 0),
    trendBullishCount: Number(row.trend_bullish_count ?? 0),
    sentimentUpPct: row.sentiment_up_pct === null ? null : Number(row.sentiment_up_pct),
    voteCount: Number(row.vote_count ?? 0),
    topMovers: Array.isArray(row.top_movers_json) ? row.top_movers_json : [],
    topLosers: Array.isArray(row.top_losers_json) ? row.top_losers_json : [],
    updatedAt: row.updated_at,
  };
}

function toFinishBreakdown(row: SetFinishSummaryRow): SetFinishBreakdown {
  return {
    setId: row.set_id,
    setName: row.set_name,
    finish: row.finish,
    marketCap: Number(row.market_cap ?? 0),
    cardCount: Number(row.card_count ?? 0),
    change7dPct: row.change_7d_pct === null ? null : Number(row.change_7d_pct),
    change30dPct: row.change_30d_pct === null ? null : Number(row.change_30d_pct),
    updatedAt: row.updated_at,
  };
}

export async function getLatestSetSummarySnapshot(setName: string): Promise<SetSummarySnapshot | null> {
  const setId = buildSetId(setName);
  if (!setId) return null;

  const supabase = getServerSupabaseClient();
  const { data } = await supabase
    .from("set_summary_snapshots")
    .select([
      "set_id",
      "set_name",
      "as_of_date",
      "market_cap",
      "market_cap_all_variants",
      "change_7d_pct",
      "change_30d_pct",
      "heat_score",
      "breakout_count",
      "value_zone_count",
      "trend_bullish_count",
      "sentiment_up_pct",
      "vote_count",
      "top_movers_json",
      "top_losers_json",
      "updated_at",
    ].join(", "))
    .eq("set_id", setId)
    .order("as_of_date", { ascending: false })
    .limit(1)
    .maybeSingle<SetSummarySnapshotRow>();

  return data ? toSnapshot(data) : null;
}

export async function getSetFinishBreakdown(setName: string): Promise<SetFinishBreakdown[]> {
  const setId = buildSetId(setName);
  if (!setId) return [];

  const supabase = getServerSupabaseClient();
  const { data } = await supabase
    .from("set_finish_summary_latest")
    .select("set_id, set_name, finish, market_cap, card_count, change_7d_pct, change_30d_pct, updated_at")
    .eq("set_id", setId)
    .order("market_cap", { ascending: false });

  return ((data ?? []) as SetFinishSummaryRow[]).map(toFinishBreakdown);
}

export async function getSetSummaryPageData(setName: string): Promise<SetSummaryPageData> {
  const setId = buildSetId(setName) ?? "";
  const [snapshot, finishBreakdown] = await Promise.all([
    getLatestSetSummarySnapshot(setName),
    getSetFinishBreakdown(setName),
  ]);

  return {
    setId,
    snapshot,
    finishBreakdown,
  };
}
