/**
 * lib/data/assets.ts
 *
 * Single server-side data access module for all asset pages (singles + sealed).
 *
 * ALL database reads for the frontend go through this module.
 * Nothing here calls provider APIs — it reads only internal tables:
 *   canonical_cards, card_metrics, price_history_points, price_snapshots
 *
 * Exports:
 *   getAssetPageData(slug, opts?)
 *   getDefaultVariantRef(slug)
 *   getChartSeries(slug, variantRef, days?)
 *   listMovers(opts)
 *   searchAssets(query, limit?)
 */

import { getServerSupabaseClient } from "@/lib/supabaseServer";

// ── Shared types ────────────────────────────────────────────────────────────

export type AssetMetrics = {
  // Core price stats (from refresh_card_metrics)
  median_7d: number | null;
  median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  trimmed_median_30d: number | null;
  volatility_30d: number | null;
  liquidity_score: number | null;
  percentile_rank: number | null;
  active_listings_7d: number | null;
  snapshot_count_30d: number | null;

  // Provider-supplied analytics
  provider_trend_slope_7d: number | null;
  provider_cov_price_30d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_min_price_all_time: number | null;
  provider_max_price_all_time: number | null;
  provider_price_changes_count_30d: number | null;
  provider_as_of_ts: string | null;

  // PopAlpha derived signals
  signal_trend_strength: number | null;
  signal_breakout: number | null;
  signal_value_zone: number | null;
  signals_as_of_ts: string | null;

  // Row metadata
  updated_at: string | null;
};

export type ChartPoint = { ts: string; price: number };

export type AssetPageData = {
  canonical: {
    slug: string;
    canonical_name: string;
    set_name: string | null;
    year: number | null;
    card_number: string | null;
    variant: string | null;
  };
  isSealed: boolean;
  metrics: AssetMetrics | null;
  /** True if provider_as_of_ts is older than 48 hours. */
  metricsStale: boolean;
  defaultVariantRef: string | null;
  chartSeries: ChartPoint[];
};

export type MoverItem = {
  canonical_slug: string;
  canonical_name: string | null;
  set_name: string | null;
  median_7d: number | null;
  signal_trend_strength: number | null;
  signal_breakout: number | null;
  signal_value_zone: number | null;
};

export type SearchResult = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  variant: string | null;
  median_7d: number | null;
};

// ── Constants ────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
const CHART_DAYS_DEFAULT = 30;
const CHART_POINT_LIMIT = 2000;
const CHART_MIN_POINTS = 5; // warn below this, but still return

// ── Internal helpers ────────────────────────────────────────────────────────

function isSealedSlug(slug: string): boolean {
  return slug.startsWith("sealed:");
}

function isMetricsStale(providerAsOfTs: string | null): boolean {
  if (!providerAsOfTs) return false;
  const ageMs = Date.now() - new Date(providerAsOfTs).getTime();
  return ageMs > STALE_THRESHOLD_MS;
}

// ── getDefaultVariantRef ────────────────────────────────────────────────────

/**
 * Returns the most appropriate variant_ref for a given slug.
 *
 * Rules:
 * 1. Determine preferred pattern:
 *    - sealed slug → "sealed:sealed:en:raw"
 *    - single slug → any variant_ref matching "*:nm:en:raw"
 * 2. Return preferred if it has >= 10 history points in the last 30 days.
 * 3. Fallback: return variant_ref with the most points in last 30 days.
 * 4. If no history exists at all, return the preferred pattern as a best guess.
 */
export async function getDefaultVariantRef(slug: string): Promise<string | null> {
  const supabase = getServerSupabaseClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get point counts per variant_ref in the last 30 days.
  const { data: rows } = await supabase
    .from("price_history_points")
    .select("variant_ref")
    .eq("canonical_slug", slug)
    .gte("ts", since)
    .limit(CHART_POINT_LIMIT);

  if (!rows || rows.length === 0) {
    // No history at all — return sensible default without crashing.
    return isSealedSlug(slug) ? "sealed:sealed:en:raw" : null;
  }

  // Count points per variant_ref.
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.variant_ref, (counts.get(row.variant_ref) ?? 0) + 1);
  }

  // Check if preferred variant has enough data.
  const isSealed = isSealedSlug(slug);
  if (isSealed) {
    const preferred = "sealed:sealed:en:raw";
    if ((counts.get(preferred) ?? 0) >= 10) return preferred;
  } else {
    // Singles: find first variant ending in :nm:en:raw
    const nmEnRaw = [...counts.entries()].find(([vr]) => vr.endsWith(":nm:en:raw"));
    if (nmEnRaw && nmEnRaw[1] >= 10) return nmEnRaw[0];
  }

  // Fallback: variant with the most points.
  let best: string | null = null;
  let bestCount = -1;
  for (const [vr, cnt] of counts.entries()) {
    if (cnt > bestCount) {
      best = vr;
      bestCount = cnt;
    }
  }
  return best;
}

// ── getChartSeries ──────────────────────────────────────────────────────────

/**
 * Returns time-ordered price points for the given slug + variantRef.
 * Always returns what exists (even < 5 points) — callers decide how to render.
 */
export async function getChartSeries(
  slug: string,
  variantRef: string,
  days = CHART_DAYS_DEFAULT,
): Promise<ChartPoint[]> {
  const supabase = getServerSupabaseClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("price_history_points")
    .select("ts, price")
    .eq("canonical_slug", slug)
    .eq("variant_ref", variantRef)
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(CHART_POINT_LIMIT);

  return (data ?? []).map((r) => ({ ts: r.ts as string, price: Number(r.price) }));
}

// ── getLatestMetrics ────────────────────────────────────────────────────────

/**
 * Returns the single most-recently-updated metrics row for a slug.
 * Uses DISTINCT ON equivalent: orders by updated_at DESC and takes limit 1.
 * Returns null if no metrics row exists — never throws.
 */
async function getLatestMetrics(slug: string): Promise<AssetMetrics | null> {
  const supabase = getServerSupabaseClient();

  const { data } = await supabase
    .from("card_metrics")
    .select(
      [
        "median_7d", "median_30d", "low_30d", "high_30d", "trimmed_median_30d",
        "volatility_30d", "liquidity_score", "percentile_rank",
        "active_listings_7d", "snapshot_count_30d",
        "provider_trend_slope_7d", "provider_cov_price_30d",
        "provider_price_relative_to_30d_range",
        "provider_min_price_all_time", "provider_max_price_all_time",
        "provider_price_changes_count_30d", "provider_as_of_ts",
        "signal_trend_strength", "signal_breakout", "signal_value_zone",
        "signals_as_of_ts", "updated_at",
      ].join(", ")
    )
    .eq("canonical_slug", slug)
    // For sealed: printing_id IS NULL. For singles with the canonical aggregate: also NULL.
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<AssetMetrics>();

  return data ?? null;
}

// ── getAssetPageData ────────────────────────────────────────────────────────

/**
 * Primary data loader for an asset page (single or sealed).
 *
 * Returns canonical card info, latest metrics, default variant, chart data.
 * Never throws on absent rows — returns nulls with metricsStale=false.
 *
 * opts.grade defaults to 'RAW'. opts.days defaults to 30.
 */
export async function getAssetPageData(
  slug: string,
  opts: { days?: number } = {},
): Promise<AssetPageData | null> {
  const supabase = getServerSupabaseClient();
  const days = opts.days ?? CHART_DAYS_DEFAULT;

  // Load canonical card (required — return null if missing so page can 404).
  const { data: canonical } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, year, card_number, variant")
    .eq("slug", slug)
    .maybeSingle<{
      slug: string;
      canonical_name: string;
      set_name: string | null;
      year: number | null;
      card_number: string | null;
      variant: string | null;
    }>();

  if (!canonical) return null;

  const isSealed = isSealedSlug(slug) || canonical.variant === "SEALED";

  // Load metrics, defaultVariantRef, chart in parallel.
  const [metrics, defaultVariantRef] = await Promise.all([
    getLatestMetrics(slug),
    getDefaultVariantRef(slug),
  ]);

  // Load chart only if we have a variant ref.
  const chartSeries = defaultVariantRef
    ? await getChartSeries(slug, defaultVariantRef, days)
    : [];

  return {
    canonical,
    isSealed,
    metrics,
    metricsStale: isMetricsStale(metrics?.provider_as_of_ts ?? null),
    defaultVariantRef,
    chartSeries,
  };
}

// ── listMovers ──────────────────────────────────────────────────────────────

/**
 * Returns top N assets ordered by signal_trend_strength.
 *
 * opts.cohort: 'sealed' | 'single' | 'any' (default: 'any')
 * opts.limit:  number of results (default: 10)
 * opts.direction: 'up' | 'down' (default: 'up')
 */
export async function listMovers(opts: {
  cohort?: "sealed" | "single" | "any";
  limit?: number;
  direction?: "up" | "down";
}): Promise<MoverItem[]> {
  const supabase = getServerSupabaseClient();
  const limit = opts.limit ?? 10;
  const direction = opts.direction ?? "up";
  const cohort = opts.cohort ?? "any";

  let query = supabase
    .from("card_metrics")
    .select(
      "canonical_slug, median_7d, signal_trend_strength, signal_breakout, signal_value_zone"
    )
    .is("printing_id", null)
    .eq("grade", "RAW")
    .not("signal_trend_strength", "is", null)
    .order("signal_trend_strength", { ascending: direction === "down" })
    .limit(limit);

  if (cohort === "sealed") {
    query = query.like("canonical_slug", "sealed:%");
  } else if (cohort === "single") {
    query = query.not("canonical_slug", "like", "sealed:%");
  }

  const { data } = await query;
  if (!data || data.length === 0) return [];

  // Join with canonical_cards for name + set_name.
  const slugs = data.map((r) => r.canonical_slug as string);
  const { data: cards } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name")
    .in("slug", slugs);

  const cardMap = new Map(
    (cards ?? []).map((c) => [c.slug, { canonical_name: c.canonical_name as string, set_name: c.set_name as string | null }])
  );

  return data.map((r) => ({
    canonical_slug: r.canonical_slug as string,
    canonical_name: cardMap.get(r.canonical_slug as string)?.canonical_name ?? null,
    set_name: cardMap.get(r.canonical_slug as string)?.set_name ?? null,
    median_7d: r.median_7d as number | null,
    signal_trend_strength: r.signal_trend_strength as number | null,
    signal_breakout: r.signal_breakout as number | null,
    signal_value_zone: r.signal_value_zone as number | null,
  }));
}

// ── searchAssets ─────────────────────────────────────────────────────────────

/**
 * Fuzzy search across canonical_cards, joined with latest RAW metrics.
 * Returns up to `limit` results ordered by price desc.
 */
export async function searchAssets(
  query: string,
  limit = 25,
): Promise<SearchResult[]> {
  const supabase = getServerSupabaseClient();
  const term = query.trim();
  if (!term) return [];

  const { data: cards } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, year, variant")
    .ilike("canonical_name", `%${term}%`)
    .order("canonical_name")
    .limit(limit);

  if (!cards || cards.length === 0) return [];

  const slugs = cards.map((c) => c.slug as string);
  const { data: metricsRows } = await supabase
    .from("card_metrics")
    .select("canonical_slug, median_7d")
    .in("canonical_slug", slugs)
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false });

  // Keep only latest row per slug (already ordered by updated_at desc).
  const latestMedian = new Map<string, number | null>();
  for (const m of metricsRows ?? []) {
    if (!latestMedian.has(m.canonical_slug as string)) {
      latestMedian.set(m.canonical_slug as string, m.median_7d as number | null);
    }
  }

  return cards.map((c) => ({
    slug: c.slug as string,
    canonical_name: c.canonical_name as string,
    set_name: c.set_name as string | null,
    card_number: c.card_number as string | null,
    year: c.year as number | null,
    variant: c.variant as string | null,
    median_7d: latestMedian.get(c.slug as string) ?? null,
  }));
}

// ── getSignals ───────────────────────────────────────────────────────────────

/**
 * Lightweight fetch of only the derived signal columns for a slug.
 * Returns null if no metrics row exists — never throws.
 * Uses the most-recently-updated row (grade=RAW, printing_id=NULL).
 */
export type AssetSignals = {
  signal_trend_strength: number | null;
  signal_breakout: number | null;
  signal_value_zone: number | null;
  signals_as_of_ts: string | null;
  provider_as_of_ts: string | null;
  metricsStale: boolean;
};

export async function getSignals(slug: string): Promise<AssetSignals | null> {
  const supabase = getServerSupabaseClient();

  const { data } = await supabase
    .from("card_metrics")
    .select(
      "signal_trend_strength, signal_breakout, signal_value_zone, signals_as_of_ts, provider_as_of_ts"
    )
    .eq("canonical_slug", slug)
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      signal_trend_strength: number | null;
      signal_breakout: number | null;
      signal_value_zone: number | null;
      signals_as_of_ts: string | null;
      provider_as_of_ts: string | null;
    }>();

  if (!data) return null;

  return {
    signal_trend_strength: data.signal_trend_strength,
    signal_breakout: data.signal_breakout,
    signal_value_zone: data.signal_value_zone,
    signals_as_of_ts: data.signals_as_of_ts,
    provider_as_of_ts: data.provider_as_of_ts,
    metricsStale: isMetricsStale(data.provider_as_of_ts),
  };
}

// ── Re-export CHART_MIN_POINTS so page can check sufficiency ────────────────
export { CHART_MIN_POINTS };
