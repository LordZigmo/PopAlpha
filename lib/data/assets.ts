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
import { parseVariantRef as parseCanonicalVariantRef } from "@/lib/identity/variant-ref";

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

  // Pre-computed price change percentages (from refresh_price_changes)
  change_pct_24h: number | null;
  change_pct_7d: number | null;

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
  mover_tier: "hot" | "warming" | "cooling" | "cold";
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
const RAW_HISTORY_PROVIDERS = ["SCRYDEX", "POKEMON_TCG_API"] as const;
const LEGACY_HISTORY_PROVIDERS = ["JUSTTCG"] as const;

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
  printingId: string | null;
  providerRank: number;
};

type ParsedLegacyVariantRef = {
  printing: string;
  edition: string | null;
  stamp: string | null;
  condition: string;
  language: string;
  grade: string;
};

type HistoryQueryProfile = {
  providers: readonly string[];
  sourceWindow: "snapshot" | "30d";
};

type PublicHistoryRow = {
  variant_ref: string | null;
  ts: string | null;
  provider: string | null;
  price?: number | string | null;
};

function getHistoryQueryProfiles(params: {
  grade: string;
  isSealed: boolean;
}): HistoryQueryProfile[] {
  if (params.grade === "RAW" && !params.isSealed) {
    return [
      { providers: RAW_HISTORY_PROVIDERS, sourceWindow: "snapshot" },
      { providers: LEGACY_HISTORY_PROVIDERS, sourceWindow: "30d" },
    ];
  }
  return [{ providers: LEGACY_HISTORY_PROVIDERS, sourceWindow: "30d" }];
}

function normalizeHistoryProviderName(provider: string | null | undefined): "SCRYDEX" | "JUSTTCG" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  if (normalized === "JUSTTCG") return "JUSTTCG";
  return null;
}

function historyProviderRank(provider: string | null | undefined): number {
  const normalized = normalizeHistoryProviderName(provider);
  if (normalized === "SCRYDEX") return 0;
  if (normalized === "JUSTTCG") return 1;
  return 2;
}

export function extractRawVariantPrintingId(variantRef: string): string | null {
  const rawValue = String(variantRef ?? "").trim();
  if (!rawValue.endsWith("::RAW")) return null;
  const [printingId] = rawValue.split("::");
  const normalized = printingId?.trim() ?? "";
  return normalized || null;
}

function compareIsoDesc(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

async function loadPublicHistoryRows(params: {
  slug: string;
  since: string;
  select: string;
  limit: number;
  ascending: boolean;
  variantRef?: string | null;
  profiles: HistoryQueryProfile[];
  errorLabel: string;
}): Promise<PublicHistoryRow[]> {
  const supabase = dbPublic();
  for (const profile of params.profiles) {
    let query = supabase
      .from("public_price_history")
      .select(params.select)
      .eq("canonical_slug", params.slug)
      .in("provider", [...profile.providers])
      .eq("source_window", profile.sourceWindow)
      .gte("ts", params.since)
      .order("ts", { ascending: params.ascending })
      .limit(params.limit);

    if (params.variantRef) {
      query = query.eq("variant_ref", params.variantRef);
    }

    const { data, error } = await query;
    if (error) {
      console.error(params.errorLabel, params.slug, params.variantRef ?? null, error.message);
      continue;
    }
    if ((data ?? []).length > 0) {
      return (data ?? []) as PublicHistoryRow[];
    }
  }

  return [];
}

async function getRecentVariantStats(
  slug: string,
  days = 30,
  options: { grade?: string; isSealed?: boolean } = {},
): Promise<VariantHistoryStat[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await loadPublicHistoryRows({
    slug,
    since,
    select: "variant_ref, ts, provider",
    limit: CHART_POINT_LIMIT,
    ascending: false,
    profiles: getHistoryQueryProfiles({
      grade: options.grade ?? "RAW",
      isSealed: options.isSealed ?? isSealedSlug(slug),
    }),
    errorLabel: "[getRecentVariantStats]",
  });

  const stats = new Map<string, VariantHistoryStat>();
  for (const row of rows) {
    const variantRef = String(row.variant_ref ?? "").trim();
    if (!variantRef) continue;
    const ts = row.ts ?? null;
    const current = stats.get(variantRef) ?? {
      variantRef,
      points: 0,
      latestTs: null,
      printingId: extractRawVariantPrintingId(variantRef),
      providerRank: historyProviderRank(row.provider),
    };
    current.points += 1;
    if (ts && (!current.latestTs || ts > current.latestTs)) {
      current.latestTs = ts;
    }
    stats.set(variantRef, current);
  }

  return [...stats.values()].sort((a, b) => {
    if (a.providerRank !== b.providerRank) return a.providerRank - b.providerRank;
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

export function variantRefsCompatible(source: string, candidate: string): boolean {
  if (source === candidate) return true;

  const leftRawPrintingId = extractRawVariantPrintingId(source);
  const rightRawPrintingId = extractRawVariantPrintingId(candidate);
  if (leftRawPrintingId && rightRawPrintingId) {
    return leftRawPrintingId === rightRawPrintingId;
  }

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
export async function getDefaultVariantRef(
  slug: string,
  options: { grade?: string; isSealed?: boolean } = {},
): Promise<string | null> {
  const stats = await getRecentVariantStats(slug, 30, options);
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
  options: { grade?: string; isSealed?: boolean } = {},
): Promise<ChartPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await loadPublicHistoryRows({
    slug,
    since,
    select: "ts, price, provider, variant_ref",
    limit: CHART_POINT_LIMIT,
    ascending: true,
    variantRef,
    profiles: getHistoryQueryProfiles({
      grade: options.grade ?? "RAW",
      isSealed: options.isSealed ?? isSealedSlug(slug),
    }),
    errorLabel: "[getChartSeries]",
  });

  return rows
    .map((row) => {
      const ts = row.ts ?? null;
      const price = Number(row.price);
      if (!ts || !Number.isFinite(price)) return null;
      return { ts, price };
    })
    .filter((row): row is ChartPoint => row !== null);
}

// ── getLatestMetrics ────────────────────────────────────────────────────────

/**
 * Returns the single most-recently-updated metrics row for a slug.
 * Uses DISTINCT ON equivalent: orders by updated_at DESC and takes limit 1.
 * Returns null if no metrics row exists — never throws.
 */
async function getLatestMetrics(
  slug: string,
  grade = "RAW",
  printingId: string | null = null,
): Promise<AssetMetrics | null> {
  const supabase = dbPublic();

  // Signal columns (signal_trend_strength, signal_breakout, signal_value_zone, signals_as_of_ts)
  // are excluded from public_card_metrics — paywalled behind pro views.
  let query = supabase
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
        "change_pct_24h", "change_pct_7d",
        "updated_at",
      ].join(", ")
    )
    .eq("canonical_slug", slug)
    .eq("grade", grade)
    .order("updated_at", { ascending: false })
    .limit(1);

  query = printingId ? query.eq("printing_id", printingId) : query.is("printing_id", null);

  const { data, error } = await query.maybeSingle<AssetMetrics>();

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
    getDefaultVariantRef(slug, { isSealed }),
  ]);

  // Load chart only if we have a variant ref.
  const chartSeries = defaultVariantRef
    ? await getChartSeries(slug, defaultVariantRef, days, { isSealed })
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
  const supabase = dbPublic();
  const limit = opts.limit ?? 10;
  const direction = opts.direction ?? "up";
  const cohort = opts.cohort ?? "any";

  // public_variant_movers exposes coarse mover_tier (hot/warming/cooling/cold)
  // and tier_priority (1–4) for sorting — no raw signal values or fine-grained ranks.
  let query = supabase
    .from("public_variant_movers")
    .select("canonical_slug, mover_tier, tier_priority")
    .eq("provider", "JUSTTCG")
    .eq("grade", "RAW")
    .order("tier_priority", { ascending: direction === "up" })
    .order("updated_at", { ascending: false })
    .limit(limit * 5);

  if (cohort === "sealed") {
    query = query.like("canonical_slug", "sealed:%");
  } else if (cohort === "single") {
    query = query.not("canonical_slug", "like", "sealed:%");
  }

  const { data, error: variantError } = await query;
  if (variantError) console.error("[listMovers]", variantError.message);
  if (!data || data.length === 0) return [];

  // Deduplicate to one row per canonical_slug (best tier wins).
  type MoverRow = { canonical_slug: string; mover_tier: string; tier_priority: number };
  const deduped: MoverRow[] = [];
  const seen = new Set<string>();
  for (const row of data as MoverRow[]) {
    if (seen.has(row.canonical_slug)) continue;
    seen.add(row.canonical_slug);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  if (deduped.length === 0) return [];

  const slugs = deduped.map((r) => r.canonical_slug);
  const [cardsResult, metricsResult] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name")
      .in("slug", slugs),
    supabase
      .from("public_card_metrics")
      .select("canonical_slug, median_7d, updated_at")
      .in("canonical_slug", slugs)
      .is("printing_id", null)
      .eq("grade", "RAW")
      .order("updated_at", { ascending: false }),
  ]);

  if (cardsResult.error) console.error("[listMovers] cards", cardsResult.error.message);
  if (metricsResult.error) console.error("[listMovers] metrics", metricsResult.error.message);

  const cardMap = new Map(
    (cardsResult.data ?? []).map((c) => [c.slug, { canonical_name: c.canonical_name as string, set_name: c.set_name as string | null }])
  );
  const medianMap = new Map<string, number | null>();
  for (const row of metricsResult.data ?? []) {
    const slug = row.canonical_slug as string;
    if (!medianMap.has(slug)) {
      medianMap.set(slug, row.median_7d as number | null);
    }
  }

  return deduped.map((r) => ({
    canonical_slug: r.canonical_slug,
    canonical_name: cardMap.get(r.canonical_slug)?.canonical_name ?? null,
    set_name: cardMap.get(r.canonical_slug)?.set_name ?? null,
    median_7d: medianMap.get(r.canonical_slug) ?? null,
    mover_tier: r.mover_tier as MoverItem["mover_tier"],
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
  /** (price_now − price_24h_ago) / price_24h_ago × 100, null if not enough data. */
  change_24h_pct: number | null;
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
  const recentVariantStats = await getRecentVariantStats(slug, 30, { grade, isSealed });
  const preferredVariantStats = preferredPrintingId
    ? recentVariantStats.filter((row) => row.printingId === preferredPrintingId)
    : [];
  const selectedVariant = preferredVariantStats[0] ?? recentVariantStats[0] ?? null;
  const selectedVariantRef = selectedVariant?.variantRef ?? null;
  const selectedVariantPoints = selectedVariant?.points ?? 0;
  const availableVariantRefs = recentVariantStats
    .filter((row) => row.points >= SIGNAL_MIN_POINTS)
    .map((row) => row.variantRef);

  // 3. Chart series for the selected variant.
  const series = selectedVariantRef
    ? await getChartSeries(slug, selectedVariantRef, days, { grade, isSealed })
    : [];

  // 4. Compute price metrics from series + read pre-computed changes from card_metrics.
  const price_now = series.length > 0 ? series[series.length - 1].price : null;
  const prices = series.map((p) => p.price);
  const range_30d_low  = prices.length > 0 ? Math.min(...prices) : null;
  const range_30d_high = prices.length > 0 ? Math.max(...prices) : null;

  // Read pre-computed change percentages from card_metrics (populated by refresh_price_changes).
  const metricsRow = await getLatestMetrics(
    slug,
    grade,
    grade === "RAW" && !isSealed ? preferredPrintingId : null,
  );
  const change_24h_pct = metricsRow?.change_pct_24h ?? null;
  const change_7d_pct  = metricsRow?.change_pct_7d ?? null;

  // 5. Load the exact variant_metrics row for the selected variant.
  let signals: AssetViewModel["signals"] = null;
  let provider_as_of_ts: string | null = null;
  let signals_as_of_ts: string | null = null;
  let signals_history_points_30d: number | null = null;
  let reason: AssetViewModel["reason"] = null;

  if (!selectedVariantRef) {
    reason = "no_history";
  } else {
    const historyProviders = [...new Set(
      getHistoryQueryProfiles({ grade, isSealed }).flatMap((profile) => [...profile.providers]),
    )];
    // Signal columns (signal_trend, signal_breakout, signal_value, signals_as_of_ts)
    // are paywalled — no longer in public_variant_metrics. Only request what's available.
    const { data: vmRows, error: vmError } = await supabase
      .from("public_variant_metrics")
      .select("variant_ref, provider, history_points_30d, provider_as_of_ts")
      .eq("canonical_slug", slug)
      .eq("grade", grade)
      .in("provider", historyProviders)
      .order("provider_as_of_ts", { ascending: false })
      .limit(20);

    if (vmError) console.error("[buildAssetViewModel] variant_metrics", slug, vmError.message);

    const typedVmRows = (vmRows ?? []) as Array<{
      variant_ref: string;
      provider: string | null;
      history_points_30d: number | null;
      provider_as_of_ts: string | null;
    }>;
    const vmRow = [...typedVmRows]
      .filter((row) => variantRefsCompatible(selectedVariantRef, row.variant_ref))
      .sort((left, right) => {
        const providerDelta = historyProviderRank(left.provider) - historyProviderRank(right.provider);
        if (providerDelta !== 0) return providerDelta;
        const tsDelta = compareIsoDesc(left.provider_as_of_ts, right.provider_as_of_ts);
        if (tsDelta !== 0) return tsDelta;
        return (right.history_points_30d ?? 0) - (left.history_points_30d ?? 0);
      })[0]
      ?? null;

    const typedVmRow = vmRow as {
      variant_ref: string;
      provider: string | null;
      history_points_30d: number | null;
      provider_as_of_ts: string | null;
    } | null;

    provider_as_of_ts = typedVmRow?.provider_as_of_ts ?? metricsRow?.provider_as_of_ts ?? null;
    // signals_as_of_ts not available in public view — paywalled.
    const computedHistoryPoints = Math.max(selectedVariantPoints, typedVmRow?.history_points_30d ?? 0);
    signals_history_points_30d = computedHistoryPoints > 0 ? computedHistoryPoints : null;
    const enoughHistory = computedHistoryPoints >= SIGNAL_MIN_POINTS;

    // Signal columns are paywalled — not available in public_variant_metrics.
    // Signals will always be null here; pro users get them via /api/pro/signals.
    reason = enoughHistory ? null : "insufficient_recent_activity";
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
    change_24h_pct,
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
