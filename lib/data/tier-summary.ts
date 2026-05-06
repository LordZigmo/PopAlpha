/**
 * lib/data/tier-summary.ts
 *
 * Server-side data helpers for the public /data page. The page is the
 * consumer-facing transparency story for how PopAlpha prices Pokemon
 * cards: every card carries a `refresh_tier` (hot / warm / sparse /
 * dormant) that determines how often we refresh its price and how we
 * present that price in the UI.
 *
 * Two queries:
 *   - getTierSummary(): tier counts + last-classified timestamp
 *   - getPipelineStatus(): is the homepage rails refresh up to date?
 *
 * Both are intentionally tiny. The page replaces the old freshness
 * monitor that scanned 12M+ rows in price_history_points; this version
 * reads only canonical_cards (~23k rows) and daily_top_movers (one row
 * per kind per day).
 */
import { createClient } from "@supabase/supabase-js";

export type RefreshTier = "hot" | "warm" | "sparse" | "dormant";

export type TierSummaryEntry = {
  tier: RefreshTier;
  count: number;
  pct: number;
};

export type TierSummary = {
  tiers: TierSummaryEntry[];
  total: number;
  computedAt: string | null;
};

export type PipelineStatusState = "live" | "catching_up" | "stale" | "unknown";

export type PipelineStatus = {
  state: PipelineStatusState;
  latestRailsComputedAt: string | null;
  daysStale: number | null;
};

const TIER_ORDER: RefreshTier[] = ["hot", "warm", "sparse", "dormant"];

function publicSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("tier-summary: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getTierSummary(): Promise<TierSummary> {
  const supabase = publicSupabase();
  const counts: Record<RefreshTier, number> = { hot: 0, warm: 0, sparse: 0, dormant: 0 };

  for (const tier of TIER_ORDER) {
    const { count, error } = await supabase
      .from("canonical_cards")
      .select("slug", { count: "exact", head: true })
      .eq("refresh_tier", tier);
    if (error) throw new Error(`canonical_cards(tier=${tier}): ${error.message}`);
    counts[tier] = count ?? 0;
  }

  const total = TIER_ORDER.reduce((sum, t) => sum + counts[t], 0);

  const { data: latest } = await supabase
    .from("canonical_cards")
    .select("refresh_tier_computed_at")
    .not("refresh_tier_computed_at", "is", null)
    .order("refresh_tier_computed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ refresh_tier_computed_at: string }>();

  const tiers: TierSummaryEntry[] = TIER_ORDER.map((tier) => ({
    tier,
    count: counts[tier],
    pct: total > 0 ? (counts[tier] / total) * 100 : 0,
  }));

  return {
    tiers,
    total,
    computedAt: latest?.refresh_tier_computed_at ?? null,
  };
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
  const supabase = publicSupabase();
  const { data, error } = await supabase
    .from("daily_top_movers")
    .select("computed_at_date, computed_at")
    .order("computed_at_date", { ascending: false })
    .limit(1)
    .maybeSingle<{ computed_at_date: string; computed_at: string }>();

  if (error) throw new Error(`daily_top_movers(latest): ${error.message}`);

  if (!data) {
    return { state: "unknown", latestRailsComputedAt: null, daysStale: null };
  }

  const today = new Date().toISOString().slice(0, 10);
  const newest = data.computed_at_date;
  const daysStale = Math.max(
    0,
    Math.floor((Date.parse(today) - Date.parse(newest)) / (1000 * 60 * 60 * 24)),
  );

  let state: PipelineStatusState;
  if (daysStale === 0) state = "live";
  else if (daysStale === 1) state = "catching_up";
  else state = "stale";

  return {
    state,
    latestRailsComputedAt: data.computed_at,
    daysStale,
  };
}
