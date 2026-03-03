/**
 * lib/data/assets.ts
 *
 * Single server-side data access module for all asset pages (singles + sealed).
 *
 * ALL database reads for the frontend go through this module.
 * Nothing here calls provider APIs — it reads only internal tables:
 *   canonical_cards, card_metrics, variant_metrics, price_history_points, price_snapshots
 *
 * Exports:
 *   getAssetPageData(slug, opts?)
 *   getDefaultVariantRef(slug)
 *   getChartSeries(slug, variantRef, days?)
 *   listMovers(opts)
 *   searchAssets(query, limit?)
 */

import { dbPublic } from "@/lib/db";
import { dbAdmin } from "@/lib/db/admin";
import { parseVariantRef as parseCanonicalVariantRef } from "@/lib/identity/variant-ref";
// Signal label functions removed — signal columns are paywalled out of public views.
// When pro UI is built, re-add: trendSignalLabel, breakoutSignalLabel, valueSignalLabel
// from "@/lib/signals/scoring".
import { hasPro } from "@/lib/entitlements";

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
const CHART_MIN_POINTS = 5;    // warn below this, but still return
const SIGNAL_MIN_POINTS = 10;  // minimum history points to show signals

// ── Internal helpers ────────────────────────────────────────────────────────

function isSealedSlug(slug: string): boolean {
  return slug.startsWith("sealed:");
}

function isMetricsStale(providerAsOfTs: string | null): boolean {
  if (!providerAsOfTs) return false;
  const ageMs = Date.now() - new Date(providerAsOfTs).getTime();
  return ageMs > STALE_THRESHOLD_MS;
}

type VariantHistoryStat = {
  variantRef: string;
  points: number;
  latestTs: string | null;
};

type ParsedLegacyVariantRef = {
  printing: string;
  edition: string | null;
  stamp: string | null;
  condition: string;
  language: string;
  grade: string;
};

async function getRecentVariantStats(slug: string, days = 30): Promise<VariantHistoryStat[]> {
  const supabase = dbPublic();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("public_price_history")
    .select("variant_ref, ts")
    .eq("canonical_slug", slug)
    .gte("ts", since)
    .limit(CHART_POINT_LIMIT);

  if (error) console.error("[getRecentVariantStats]", slug, error.message);

  const stats = new Map<string, VariantHistoryStat>();
  for (const row of data ?? []) {
    const variantRef = row.variant_ref as string;
    const ts = (row.ts as string | null) ?? null;
    const current = stats.get(variantRef) ?? { variantRef, points: 0, latestTs: null };
    current.points += 1;
    if (ts && (!current.latestTs || ts > current.latestTs)) {
      current.latestTs = ts;
    }
    stats.set(variantRef, current);
  }

  return [...stats.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (a.latestTs === b.latestTs) return a.variantRef.localeCompare(b.variantRef);
    if (!a.latestTs) return 1;
    if (!b.latestTs) return -1;
    return b.latestTs.localeCompare(a.latestTs);
  });
}

function parseLegacyVariantRef(variantRef: string): ParsedLegacyVariantRef | null {
  const parts = variantRef.split(":");
  if (parts.length === 6) {
    const [printing, edition, stamp, condition, language, grade] = parts;
    return { printing, edition, stamp, condition, language, grade };
  }
  if (parts.length === 4) {
    const [printing, condition, language, grade] = parts;
    return { printing, edition: null, stamp: null, condition, language, grade };
  }
  return null;
}

function variantRefsCompatible(source: string, candidate: string): boolean {
  if (source === candidate) return true;

  const leftCanonical = parseCanonicalVariantRef(source);
  const rightCanonical = parseCanonicalVariantRef(candidate);
  if (leftCanonical && rightCanonical) {
    return (
      leftCanonical.printingId === rightCanonical.printingId
      && leftCanonical.mode === rightCanonical.mode
      && leftCanonical.provider === rightCanonical.provider
      && leftCanonical.gradeBucket === rightCanonical.gradeBucket
    );
  }

  const left = parseLegacyVariantRef(source);
  const right = parseLegacyVariantRef(candidate);
  if (!left || !right) return false;
  if (left.printing !== right.printing) return false;
  if (left.condition !== right.condition) return false;
  if (left.language !== right.language) return false;
  if (left.grade !== right.grade) return false;
  if (left.edition && right.edition && left.edition !== right.edition) return false;
  if (left.stamp && right.stamp && left.stamp !== right.stamp) return false;
  return true;
}

// ── getDefaultVariantRef ────────────────────────────────────────────────────

/**
 * Returns the dominant variant_ref in the last 30 days.
 * Ordered by:
 * 1. most history points
 * 2. most recent point timestamp
 */
export async function getDefaultVariantRef(slug: string): Promise<string | null> {
  const stats = await getRecentVariantStats(slug, 30);
  return stats[0]?.variantRef ?? null;
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
  const supabase = dbPublic();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("public_price_history")
    .select("ts, price")
    .eq("canonical_slug", slug)
    .eq("variant_ref", variantRef)
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(CHART_POINT_LIMIT);

  if (error) console.error("[getChartSeries]", slug, variantRef, error.message);

  return (data ?? []).map((r) => ({ ts: r.ts as string, price: Number(r.price) }));
}

// ── getLatestMetrics ────────────────────────────────────────────────────────

/**
 * Returns the single most-recently-updated metrics row for a slug.
 * Uses DISTINCT ON equivalent: orders by updated_at DESC and takes limit 1.
 * Returns null if no metrics row exists — never throws.
 */
async function getLatestMetrics(slug: string): Promise<AssetMetrics | null> {
  const supabase = dbPublic();

  // Signal columns (signal_trend_strength, signal_breakout, signal_value_zone, signals_as_of_ts)
  // are excluded from public_card_metrics — paywalled behind pro views.
  const { data, error } = await supabase
    .from("public_card_metrics")
    .select(
      [
        "median_7d", "median_30d", "low_30d", "high_30d", "trimmed_median_30d",
        "volatility_30d", "liquidity_score", "percentile_rank",
        "active_listings_7d", "snapshot_count_30d",
        "provider_trend_slope_7d", "provider_cov_price_30d",
        "provider_price_relative_to_30d_range",
        "provider_min_price_all_time", "provider_max_price_all_time",
        "provider_price_changes_count_30d", "provider_as_of_ts",
        "updated_at",
      ].join(", ")
    )
    .eq("canonical_slug", slug)
    // For sealed: printing_id IS NULL. For singles with the canonical aggregate: also NULL.
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<AssetMetrics>();

  if (error) console.error("[getLatestMetrics]", slug, error.message);

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
  const supabase = dbPublic();
  const days = opts.days ?? CHART_DAYS_DEFAULT;

  // Load canonical card (required — return null if missing so page can 404).
  const { data: canonical, error: canonicalError } = await supabase
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

  if (canonicalError) console.error("[getAssetPageData]", slug, canonicalError.message);
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
// TODO: When a movers UI is built, move this behind an API route with proper auth.
export async function listMovers(opts: {
  cohort?: "sealed" | "single" | "any";
  limit?: number;
  direction?: "up" | "down";
}): Promise<MoverItem[]> {
  // Uses dbAdmin + pro_variant_metrics because signal columns are paywalled
  // out of the public view. Sorting by signal_trend requires the pro view.
  const admin = dbAdmin();
  const pub = dbPublic();
  const limit = opts.limit ?? 10;
  const direction = opts.direction ?? "up";
  const cohort = opts.cohort ?? "any";

  let query = admin
    .from("pro_variant_metrics")
    .select("canonical_slug, signal_trend, signal_breakout, signal_value")
    .eq("provider", "JUSTTCG")
    .eq("grade", "RAW")
    .not("signal_trend", "is", null)
    .order("signal_trend", { ascending: direction === "down" })
    .limit(limit * 5);

  if (cohort === "sealed") {
    query = query.like("canonical_slug", "sealed:%");
  } else if (cohort === "single") {
    query = query.not("canonical_slug", "like", "sealed:%");
  }

  const { data, error: variantError } = await query;
  if (variantError) console.error("[listMovers]", variantError.message);
  if (!data || data.length === 0) return [];

  const signalRows: Array<{
    canonical_slug: string;
    signal_trend: number | null;
    signal_breakout: number | null;
    signal_value: number | null;
  }> = [];
  const seen = new Set<string>();
  for (const row of data) {
    const slug = row.canonical_slug as string;
    if (seen.has(slug)) continue;
    seen.add(slug);
    signalRows.push({
      canonical_slug: slug,
      signal_trend: row.signal_trend as number | null,
      signal_breakout: row.signal_breakout as number | null,
      signal_value: row.signal_value as number | null,
    });
    if (signalRows.length >= limit) break;
  }
  if (signalRows.length === 0) return [];

  // Join with canonical_cards for name + set_name (public read is fine).
  const slugs = signalRows.map((r) => r.canonical_slug);
  const { data: cards, error: cardsError } = await pub
    .from("canonical_cards")
    .select("slug, canonical_name, set_name")
    .in("slug", slugs);

  if (cardsError) console.error("[listMovers] cards", cardsError.message);

  const { data: metricsRows, error: metricsError } = await pub
    .from("public_card_metrics")
    .select("canonical_slug, median_7d, updated_at")
    .in("canonical_slug", slugs)
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false });

  if (metricsError) console.error("[listMovers] metrics", metricsError.message);

  const cardMap = new Map(
    (cards ?? []).map((c) => [c.slug, { canonical_name: c.canonical_name as string, set_name: c.set_name as string | null }])
  );
  const medianMap = new Map<string, number | null>();
  for (const row of metricsRows ?? []) {
    const slug = row.canonical_slug as string;
    if (!medianMap.has(slug)) {
      medianMap.set(slug, row.median_7d as number | null);
    }
  }

  const isPro = hasPro();
  return signalRows.map((r) => ({
    canonical_slug: r.canonical_slug,
    canonical_name: cardMap.get(r.canonical_slug)?.canonical_name ?? null,
    set_name: cardMap.get(r.canonical_slug)?.set_name ?? null,
    median_7d: medianMap.get(r.canonical_slug) ?? null,
    signal_trend_strength: isPro ? r.signal_trend : null,
    signal_breakout: isPro ? r.signal_breakout : null,
    signal_value_zone: isPro ? r.signal_value : null,
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
  const supabase = dbPublic();
  const term = query.trim();
  if (!term) return [];

  const { data: cards, error: cardsError } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, year, variant")
    .ilike("canonical_name", `%${term}%`)
    .order("canonical_name")
    .limit(limit);

  if (cardsError) console.error("[searchAssets]", cardsError.message);
  if (!cards || cards.length === 0) return [];

  const slugs = cards.map((c) => c.slug as string);
  const { data: metricsRows, error: metricsError } = await supabase
    .from("public_card_metrics")
    .select("canonical_slug, median_7d")
    .in("canonical_slug", slugs)
    .is("printing_id", null)
    .eq("grade", "RAW")
    .order("updated_at", { ascending: false });

  if (metricsError) console.error("[searchAssets] metrics", metricsError.message);

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
 * Returns null if the asset is unknown — never throws.
 * Signals come from the selected variant_metrics row only.
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
  const vm = await buildAssetViewModel(slug);
  if (!vm) return null;

  return {
    signal_trend_strength: vm.signals?.trend?.score ?? null,
    signal_breakout: vm.signals?.breakout?.score ?? null,
    signal_value_zone: vm.signals?.value?.score ?? null,
    signals_as_of_ts: vm.signals_as_of_ts ?? null,
    provider_as_of_ts: vm.provider_as_of_ts,
    metricsStale: isMetricsStale(vm.provider_as_of_ts),
  };
}

// ── Signal display + view model ──────────────────────────────────────────────

/** A signal value squashed to 0–100 with a human label. */
export type SignalDisplay = {
  label: string;
  score: number;   // 0–100 (1 dp)
  raw?: number;    // pre-squash value, for tooltips / debug
};

export type AssetViewModel = {
  identity: {
    slug: string;
    canonical_name: string;
    set_name: string | null;
    card_number: string | null;
    variant: "SEALED" | "SINGLE";
  };
  /** Best variant_ref to display (sealed:sealed:en:raw / *:nm:en:raw / fallback). */
  selectedVariantRef: string | null;
  /** Variant refs that have >= 10 history points in the last 30 days. */
  availableVariantRefs: string[];
  /** Latest price from the 30d history series. */
  price_now: number | null;
  range_30d_low: number | null;
  range_30d_high: number | null;
  chartSeries: ChartPoint[];
  /** (price_now − price_7d_ago) / price_7d_ago × 100, null if not enough data. */
  change_7d_pct: number | null;
  provider_as_of_ts: string | null;
  signals_as_of_ts: string | null;
  signals_history_points_30d: number | null;
  reason: "no_history" | "insufficient_recent_activity" | null;
  /**
   * Null when no signal data exists yet (provider hasn't run or fields are null).
   * Each sub-signal is independently null-able.
   */
  signals: {
    trend:    SignalDisplay | null;
    breakout: SignalDisplay | null;
    value:    SignalDisplay | null;
  } | null;
};

/** Compute % change from the price closest to 7 days ago to price_now. */
function computeChange7dPct(series: ChartPoint[]): number | null {
  if (series.length < 2) return null;
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const priceNow = series[series.length - 1].price;
  // Series is ts-asc. Walk forward, keep last point at-or-before 7d ago.
  let price7dAgo: number | null = null;
  for (const pt of series) {
    if (new Date(pt.ts).getTime() <= sevenDaysAgoMs) {
      price7dAgo = pt.price;
    } else {
      break;
    }
  }
  if (price7dAgo === null || price7dAgo <= 0) return null;
  return ((priceNow - price7dAgo) / price7dAgo) * 100;
}

/**
 * Builds a display-ready view model for an asset page.
 *
 * The page renders whatever is present; it should contain no business logic.
 * All missing data is surfaced as null — never as placeholder strings.
 */
export async function buildAssetViewModel(
  slug: string,
  grade = "RAW",
  days = 30,
  preferredPrintingId: string | null = null,
): Promise<AssetViewModel | null> {
  const supabase = dbPublic();

  // 1. Canonical card — return null if unknown so page can 404.
  const { data: canonical, error: canonicalError } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, variant")
    .eq("slug", slug)
    .maybeSingle<{
      slug: string; canonical_name: string; set_name: string | null;
      card_number: string | null; variant: string | null;
    }>();
  if (canonicalError) console.error("[buildAssetViewModel]", slug, canonicalError.message);
  if (!canonical) return null;

  const isSealed = isSealedSlug(slug) || canonical.variant === "SEALED";

  // 2. Determine the single variant_ref we should display.
  const recentVariantStats = await getRecentVariantStats(slug, 30);
  const preferredVariantStats = preferredPrintingId
    ? recentVariantStats.filter((row) => {
        const parsed = parseCanonicalVariantRef(row.variantRef);
        return parsed?.printingId === preferredPrintingId;
      })
    : [];
  const selectedVariantRef = preferredVariantStats[0]?.variantRef ?? recentVariantStats[0]?.variantRef ?? null;
  const selectedVariantPoints = recentVariantStats[0]?.points ?? 0;
  const availableVariantRefs = recentVariantStats
    .filter((row) => row.points >= SIGNAL_MIN_POINTS)
    .map((row) => row.variantRef);

  // 3. Chart series for the selected variant.
  const series = selectedVariantRef
    ? await getChartSeries(slug, selectedVariantRef, days)
    : [];

  // 4. Compute price metrics from series.
  const price_now = series.length > 0 ? series[series.length - 1].price : null;
  const prices = series.map((p) => p.price);
  const range_30d_low  = prices.length > 0 ? Math.min(...prices) : null;
  const range_30d_high = prices.length > 0 ? Math.max(...prices) : null;
  const change_7d_pct  = computeChange7dPct(series);

  // 5. Load the exact variant_metrics row for the selected variant.
  let signals: AssetViewModel["signals"] = null;
  let provider_as_of_ts: string | null = null;
  let signals_as_of_ts: string | null = null;
  let signals_history_points_30d: number | null = null;
  let reason: AssetViewModel["reason"] = null;

  if (!selectedVariantRef) {
    reason = "no_history";
  } else {
    // Signal columns (signal_trend, signal_breakout, signal_value, signals_as_of_ts)
    // are paywalled — no longer in public_variant_metrics. Only request what's available.
    const { data: vmRows, error: vmError } = await supabase
      .from("public_variant_metrics")
      .select("variant_ref, history_points_30d, provider_as_of_ts")
      .eq("canonical_slug", slug)
      .eq("provider", "JUSTTCG")
      .eq("grade", grade)
      .order("history_points_30d", { ascending: false })
      .limit(10);

    if (vmError) console.error("[buildAssetViewModel] variant_metrics", slug, vmError.message);

    const vmRow = (vmRows ?? []).find((row) => row.variant_ref === selectedVariantRef)
      ?? (vmRows ?? []).find((row) => variantRefsCompatible(selectedVariantRef, row.variant_ref as string))
      ?? null;

    const typedVmRow = vmRow as {
      variant_ref: string;
      history_points_30d: number | null;
      provider_as_of_ts: string | null;
    } | null;

    provider_as_of_ts = typedVmRow?.provider_as_of_ts ?? null;
    // signals_as_of_ts not available in public view — paywalled.
    signals_history_points_30d = typedVmRow?.history_points_30d ?? null;

    const selectedPoints = (preferredVariantStats.find((row) => row.variantRef === selectedVariantRef)?.points
      ?? recentVariantStats.find((row) => row.variantRef === selectedVariantRef)?.points
      ?? selectedVariantPoints);
    const enoughHistory =
      Math.max(selectedPoints, typedVmRow?.history_points_30d ?? 0) >= SIGNAL_MIN_POINTS;

    // Signal columns are paywalled — not available in public_variant_metrics.
    // Signals will always be null here; pro users get them via /api/pro/signals.
    if (!enoughHistory) {
      reason = "insufficient_recent_activity";
    } else {
      reason = "insufficient_recent_activity";
    }
  }

  return {
    identity: {
      slug: canonical.slug,
      canonical_name: canonical.canonical_name,
      set_name: canonical.set_name,
      card_number: canonical.card_number,
      variant: isSealed ? "SEALED" : "SINGLE",
    },
    selectedVariantRef,
    availableVariantRefs,
    price_now,
    range_30d_low,
    range_30d_high,
    chartSeries: series,
    change_7d_pct,
    provider_as_of_ts,
    signals_as_of_ts,
    signals_history_points_30d,
    reason,
    signals,
  };
}

// ── Re-export CHART_MIN_POINTS so page can check sufficiency ────────────────
export { CHART_MIN_POINTS };
