import { dbPublic } from "@/lib/db";

export type CanonicalRawFreshnessMonitor = {
  windowHours: number;
  asOf: string;
  cutoffIso: string;
  totalCanonicalRaw: number;
  freshCanonicalRaw: number;
  freshPct: number;
};

export async function getCanonicalRawFreshnessMonitor(windowHours = 24): Promise<CanonicalRawFreshnessMonitor> {
  const supabase = dbPublic();
  const asOf = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const [totalResult, freshResult] = await Promise.all([
    supabase
      .from("public_card_metrics")
      .select("canonical_slug", { count: "exact", head: true })
      .eq("grade", "RAW")
      .is("printing_id", null),
    supabase
      .from("public_card_metrics")
      .select("canonical_slug", { count: "exact", head: true })
      .eq("grade", "RAW")
      .is("printing_id", null)
      .gte("market_price_as_of", cutoffIso),
  ]);

  if (totalResult.error) {
    throw new Error(`freshness(total): ${totalResult.error.message}`);
  }
  if (freshResult.error) {
    throw new Error(`freshness(fresh): ${freshResult.error.message}`);
  }

  const totalCanonicalRaw = totalResult.count ?? 0;
  const freshCanonicalRaw = freshResult.count ?? 0;
  const freshPct = totalCanonicalRaw > 0
    ? Number(((freshCanonicalRaw / totalCanonicalRaw) * 100).toFixed(2))
    : 0;

  return {
    windowHours,
    asOf,
    cutoffIso,
    totalCanonicalRaw,
    freshCanonicalRaw,
    freshPct,
  };
}

type PairRow = { justtcg_price: number; scrydex_price: number };
type SlugRow = { canonical_slug: string; market_price_as_of: string | null };
type SetRow = { slug: string; set_name: string | null };

export type PricingTransparencySnapshot = {
  asOf: string;
  snapshotCoverage24h: {
    cardsWithSnapshotCount: number | null;
    cardsWithSnapshotPct: number | null;
  };
  freshnessByProvider24h: {
    justtcgPct: number | null;
    scrydexPct: number | null;
  };
  coverage: {
    both: number;
    justtcgOnly: number;
    scrydexOnly: number;
    none: number;
    bothPct: number;
    blendableMatch: number | null;
    blendableMatchPct: number | null;
    parityMismatch: number | null;
  };
  stalenessBuckets: {
    under6h: number;
    h6to24: number;
    d1to3: number;
    over3d: number;
    missingTs: number;
  };
  priceAgreement: {
    comparableCards: number;
    medianSpreadPct: number | null;
    p90SpreadPct: number | null;
  };
  outlierGuardrails: {
    ratioGte3p5Count: number;
    ratioGte3p5Pct: number | null;
  };
  outlierDiagnostics24h: {
    excludedPoints: number;
    impactedCards: number;
  };
  dataQualityFlags: {
    sentinel23456Count: number;
    pricedButMissingTsCount: number;
  };
  changeCoverage: {
    withChangePctCount: number;
    withChangePct: number;
    missingChangePctCount: number;
    missingChangePct: number;
  };
  ingestionVolume24h: {
    justtcgObservations: number | null;
    scrydexObservations: number | null;
  };
  setFreshness24h: {
    stalest: Array<{ setName: string; cards: number }>;
    freshest: Array<{ setName: string; cards: number }>;
  };
  pipelineHealth: {
    queueDepth: number | null;
    retryDepth: number | null;
    failedDepth: number | null;
  };
  anomalies: {
    providerDivergenceGt80PctCount: number;
    zeroChange24hCount: number;
    nullChange24hCount: number;
    setJumpGt40PctCount: number;
  };
  accuracyBacktest: {
    sampleSize: number;
    mae: number | null;
    mape: number | null;
    bySegment: Array<{
      segment: string;
      sampleSize: number;
      mae: number | null;
      mape: number | null;
    }>;
  };
  moversHealth: {
    highConfidenceCount: number;
    emergingCount: number;
    highConfidenceTop10MedianAbsChangePct: number | null;
    emergingTop10MedianAbsChangePct: number | null;
  };
  slo: Array<{
    key: "freshness_24h" | "coverage_both" | "change_coverage" | "agreement_p90" | "sentinel_prices" | "pipeline_retry_depth";
    label: string;
    status: "healthy" | "warning" | "critical";
    value: string;
    target: string;
  }>;
  alerts: string[];
};

export type PricingTransparencyTrendPoint = {
  capturedAt: string;
  freshnessPct: number | null;
  coverageBothPct: number | null;
  p90SpreadPct: number | null;
  queueDepth: number | null;
  retryDepth: number | null;
  failedDepth: number | null;
};

type PricingTransparencySnapshotRow = {
  captured_at: string;
  payload: PricingTransparencySnapshot | null;
};

function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length)));
  return Number(sorted[idx].toFixed(2));
}

function toFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeLiquidityWeight(activeListings7d: number): number {
  if (activeListings7d <= 1) return 0.35;
  if (activeListings7d <= 3) return 0.55;
  if (activeListings7d <= 5) return 0.75;
  if (activeListings7d <= 10) return 0.95;
  if (activeListings7d <= 20) return 1.1;
  return 1.25;
}

export async function getPricingTransparencySnapshot(): Promise<PricingTransparencySnapshot> {
  const supabase = dbPublic();
  const { data, error } = await supabase
    .from("pricing_transparency_snapshots")
    .select("captured_at, payload")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle<PricingTransparencySnapshotRow>();

  if (error) {
    throw new Error(`pricing_transparency_snapshots(latest): ${error.message}`);
  }

  if (!data?.payload) {
    throw new Error("pricing_transparency_snapshots has no captured payload yet.");
  }

  return data.payload;
}

export async function computePricingTransparencySnapshot(): Promise<PricingTransparencySnapshot> {
  const supabase = dbPublic();
  const now = new Date();
  const asOf = now.toISOString();
  const iso6h = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const iso24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const iso72h = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();

  const [
    totalRawRes,
    bothRes,
    jOnlyRes,
    sOnlyRes,
    noneRes,
    under6hRes,
    under24hRes,
    under72hRes,
    withTsRes,
    sentinelRes,
    just24hObsRes,
    scrydex24hObsRes,
    changeCoverageRes,
    zeroChangeRes,
    nullChangeRes,
    outlierExcludedCountRes,
    outlierImpactedRowsRes,
    recentRawRowsRes,
    backtestSnapshotRes,
    moversHealthRowsRes,
  ] = await Promise.all([
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).not("justtcg_price", "is", null).not("scrydex_price", "is", null),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).not("justtcg_price", "is", null).is("scrydex_price", null),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).is("justtcg_price", null).not("scrydex_price", "is", null),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).is("justtcg_price", null).is("scrydex_price", null),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).gte("market_price_as_of", iso6h),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).gte("market_price_as_of", iso24h),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).gte("market_price_as_of", iso72h),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).not("market_price_as_of", "is", null),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).or("scrydex_price.eq.23456.78,justtcg_price.eq.23456.78"),
    supabase.from("public_price_history").select("ts", { count: "exact", head: true }).eq("provider", "JUSTTCG").eq("source_window", "snapshot").gte("ts", iso24h),
    supabase.from("public_price_history").select("ts", { count: "exact", head: true }).in("provider", ["SCRYDEX", "POKEMON_TCG_API"]).eq("source_window", "snapshot").gte("ts", iso24h),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).or("change_pct_24h.not.is.null,change_pct_7d.not.is.null"),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).eq("change_pct_24h", 0),
    supabase.from("public_card_metrics").select("canonical_slug", { count: "exact", head: true }).eq("grade", "RAW").is("printing_id", null).is("change_pct_24h", null),
    supabase.from("outlier_excluded_points").select("id", { count: "exact", head: true }).gte("captured_at", iso24h),
    supabase.from("outlier_excluded_points").select("canonical_slug").gte("captured_at", iso24h).limit(10000),
    supabase.from("public_card_metrics").select("canonical_slug, change_pct_24h").eq("grade", "RAW").is("printing_id", null).not("change_pct_24h", "is", null).limit(10000),
    supabase
      .from("realized_sales_backtest_snapshots")
      .select("sample_size, mae, mape, payload, captured_at")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("public_card_metrics")
      .select("canonical_slug, change_pct_24h, change_pct_7d, market_confidence_score, market_low_confidence, market_provenance, market_price_as_of, active_listings_7d")
      .eq("grade", "RAW")
      .is("printing_id", null)
      .limit(15000),
  ]);

  const totalRaw = totalRawRes.count ?? 0;
  const both = bothRes.count ?? 0;
  const justtcgOnly = jOnlyRes.count ?? 0;
  const scrydexOnly = sOnlyRes.count ?? 0;
  const none = noneRes.count ?? 0;
  const under6h = under6hRes.count ?? 0;
  const under24h = under24hRes.count ?? 0;
  const under72h = under72hRes.count ?? 0;
  const withTs = withTsRes.count ?? 0;
  const missingTs = Math.max(0, totalRaw - withTs);
  const changeCoverageCount = changeCoverageRes.count ?? 0;
  const changeCoveragePct = totalRaw > 0
    ? Number(((changeCoverageCount / totalRaw) * 100).toFixed(2))
    : 0;
  const missingChangeCount = Math.max(0, totalRaw - changeCoverageCount);
  const missingChangePct = totalRaw > 0
    ? Number(((missingChangeCount / totalRaw) * 100).toFixed(2))
    : 0;
  const zeroChange24hCount = zeroChangeRes.count ?? 0;
  const nullChange24hCount = nullChangeRes.count ?? 0;
  const outlierExcludedPoints24h = outlierExcludedCountRes.error ? 0 : (outlierExcludedCountRes.count ?? 0);
  const outlierImpactedCards24h = outlierImpactedRowsRes.error
    ? 0
    : new Set((outlierImpactedRowsRes.data ?? []).map((row) => String((row as { canonical_slug: string }).canonical_slug))).size;
  let blendableMatch: number | null = null;
  let parityMismatch: number | null = null;
  const [matchParityRes, mismatchParityRes] = await Promise.all([
    supabase.from("canonical_raw_provider_parity").select("canonical_slug", { count: "exact", head: true }).eq("parity_status", "MATCH"),
    supabase.from("canonical_raw_provider_parity").select("canonical_slug", { count: "exact", head: true }).eq("parity_status", "MISMATCH"),
  ]);
  if (!matchParityRes.error) blendableMatch = matchParityRes.count ?? 0;
  if (!mismatchParityRes.error) parityMismatch = mismatchParityRes.count ?? 0;

  // Provider freshness (distinct canonical cards with snapshot observations in the
  // last 24h). Canonical RAW variant_metrics rows are not the live freshness source.
  let snapshotCoverage24h = {
    cardsWithSnapshotCount: null as number | null,
    cardsWithSnapshotPct: null as number | null,
  };
  let providerFreshness = { justtcgPct: null as number | null, scrydexPct: null as number | null };
  const providerRowsRes = await supabase
    .from("public_price_history")
    .select("provider, canonical_slug")
    .eq("source_window", "snapshot")
    .gte("ts", iso24h)
    .limit(25000);
  if (!providerRowsRes.error) {
    const anyFresh = new Set<string>();
    const justtcgFresh = new Set<string>();
    const scrydexFresh = new Set<string>();
    for (const row of (providerRowsRes.data ?? []) as Array<{ provider: string; canonical_slug: string }>) {
      const slug = row.canonical_slug;
      if (!slug) continue;
      anyFresh.add(slug);
      if (row.provider === "JUSTTCG") justtcgFresh.add(slug);
      if (row.provider === "SCRYDEX" || row.provider === "POKEMON_TCG_API") scrydexFresh.add(slug);
    }
    if (totalRaw > 0) {
      snapshotCoverage24h = {
        cardsWithSnapshotCount: anyFresh.size,
        cardsWithSnapshotPct: Number(((anyFresh.size / totalRaw) * 100).toFixed(2)),
      };
      providerFreshness = {
        justtcgPct: Number(((justtcgFresh.size / totalRaw) * 100).toFixed(2)),
        scrydexPct: Number(((scrydexFresh.size / totalRaw) * 100).toFixed(2)),
      };
    }
  }

  // Agreement + outlier stats.
  const agreementRes = await supabase
    .from("public_card_metrics")
    .select("justtcg_price, scrydex_price")
    .eq("grade", "RAW")
    .is("printing_id", null)
    .not("justtcg_price", "is", null)
    .not("scrydex_price", "is", null)
    .limit(10000);
  const pairs = (agreementRes.data ?? []) as PairRow[];
  const spreads: number[] = [];
  let ratioGte3p5Count = 0;
  let divergenceGt80PctCount = 0;
  for (const row of pairs) {
    const a = row.justtcg_price;
    const b = row.scrydex_price;
    if (!(a > 0 && b > 0)) continue;
    const mean = (a + b) / 2;
    spreads.push((Math.abs(a - b) / mean) * 100);
    if ((Math.abs(a - b) / mean) * 100 >= 80) divergenceGt80PctCount += 1;
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    if (low > 0 && high / low >= 3.5) ratioGte3p5Count += 1;
  }
  spreads.sort((a, b) => a - b);

  const jumpRows = (recentRawRowsRes.data ?? []) as Array<{ canonical_slug: string; change_pct_24h: number | null }>;
  const slugsForJump = jumpRows
    .filter((row) => Math.abs(toFinite(row.change_pct_24h) ?? 0) >= 40)
    .map((row) => row.canonical_slug)
    .filter(Boolean);
  let setJumpGt40PctCount = 0;
  if (slugsForJump.length > 0) {
    const uniqueSlugs = [...new Set(slugsForJump)];
    const setNames = new Set<string>();
    for (let i = 0; i < uniqueSlugs.length; i += 500) {
      const batch = uniqueSlugs.slice(i, i + 500);
      const setRes = await supabase
        .from("canonical_cards")
        .select("slug, set_name")
        .in("slug", batch);
      if (setRes.error) continue;
      for (const row of (setRes.data ?? []) as Array<{ slug: string; set_name: string | null }>) {
        if (row.set_name) setNames.add(row.set_name);
      }
    }
    setJumpGt40PctCount = setNames.size;
  }

  // Priced but missing timestamp.
  let pricedButMissingTsCount = 0;
  const pricedRes = await supabase
    .from("public_card_metrics")
    .select("canonical_slug", { count: "exact", head: true })
    .eq("grade", "RAW")
    .is("printing_id", null)
    .or("justtcg_price.not.is.null,scrydex_price.not.is.null");
  const pricedWithTsRes = await supabase
    .from("public_card_metrics")
    .select("canonical_slug", { count: "exact", head: true })
    .eq("grade", "RAW")
    .is("printing_id", null)
    .not("market_price_as_of", "is", null)
    .or("justtcg_price.not.is.null,scrydex_price.not.is.null");
  if (!pricedRes.error && !pricedWithTsRes.error) {
    pricedButMissingTsCount = Math.max(0, (pricedRes.count ?? 0) - (pricedWithTsRes.count ?? 0));
  }

  // Set-level top stale/fresh (sampled up to 10k cards).
  const [staleRowsRes, freshRowsRes] = await Promise.all([
    supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price_as_of")
      .eq("grade", "RAW")
      .is("printing_id", null)
      .lt("market_price_as_of", iso24h)
      .limit(10000),
    supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price_as_of")
      .eq("grade", "RAW")
      .is("printing_id", null)
      .gte("market_price_as_of", iso24h)
      .limit(10000),
  ]);
  const staleRows = (staleRowsRes.data ?? []) as SlugRow[];
  const freshRows = (freshRowsRes.data ?? []) as SlugRow[];
  const allSetSlugs = [...new Set([...staleRows, ...freshRows].map((r) => r.canonical_slug).filter(Boolean))];
  const setMap = new Map<string, string>();
  for (let i = 0; i < allSetSlugs.length; i += 500) {
    const batch = allSetSlugs.slice(i, i + 500);
    const cardRes = await supabase
      .from("canonical_cards")
      .select("slug, set_name")
      .in("slug", batch);
    if (cardRes.error) continue;
    for (const row of (cardRes.data ?? []) as SetRow[]) {
      setMap.set(row.slug, row.set_name ?? "Unknown Set");
    }
  }
  const staleBySet = new Map<string, number>();
  const freshBySet = new Map<string, number>();
  for (const row of staleRows) {
    const set = setMap.get(row.canonical_slug) ?? "Unknown Set";
    staleBySet.set(set, (staleBySet.get(set) ?? 0) + 1);
  }
  for (const row of freshRows) {
    const set = setMap.get(row.canonical_slug) ?? "Unknown Set";
    freshBySet.set(set, (freshBySet.get(set) ?? 0) + 1);
  }
  const stalest = [...staleBySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([setName, cards]) => ({ setName, cards }));
  const freshest = [...freshBySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([setName, cards]) => ({ setName, cards }));

  // Pipeline queue health (may be unavailable in anon context).
  let queueDepth: number | null = null;
  let retryDepth: number | null = null;
  let failedDepth: number | null = null;
  const [qRes, rRes, fRes] = await Promise.all([
    supabase.from("pipeline_jobs").select("id", { count: "exact", head: true }).eq("status", "QUEUED"),
    supabase.from("pipeline_jobs").select("id", { count: "exact", head: true }).eq("status", "RETRY"),
    supabase.from("pipeline_jobs").select("id", { count: "exact", head: true }).eq("status", "FAILED"),
  ]);
  if (!qRes.error) queueDepth = qRes.count ?? 0;
  if (!rRes.error) retryDepth = rRes.count ?? 0;
  if (!fRes.error) failedDepth = fRes.count ?? 0;

  const latestBacktest = backtestSnapshotRes.error
    ? null
    : (backtestSnapshotRes.data as {
      sample_size: number | null;
      mae: number | null;
      mape: number | null;
      payload: {
        bySegment?: Array<{ segment: string; sampleSize: number; mae: number | null; mape: number | null }>;
      } | null;
    } | null);
  const accuracyBacktest = {
    sampleSize: latestBacktest?.sample_size ?? 0,
    mae: toFinite(latestBacktest?.mae),
    mape: toFinite(latestBacktest?.mape),
    bySegment: Array.isArray(latestBacktest?.payload?.bySegment)
      ? latestBacktest.payload.bySegment.slice(0, 12)
      : [],
  };

  const moverRows = (moversHealthRowsRes.data ?? []) as Array<{
    canonical_slug: string;
    change_pct_24h: number | null;
    change_pct_7d: number | null;
    market_confidence_score: number | null;
    market_low_confidence: boolean | null;
    market_provenance: {
      sampleCounts7d?: { justtcg?: number; scrydex?: number };
    } | null;
    market_price_as_of: string | null;
    active_listings_7d: number | null;
  }>;
  const highConfidenceScores: number[] = [];
  const emergingScores: number[] = [];
  for (const row of moverRows) {
    const changePct = Math.abs(toFinite(row.change_pct_24h) ?? toFinite(row.change_pct_7d) ?? 0);
    if (changePct < 2.5) continue;
    const confidenceScore = toFinite(row.market_confidence_score) ?? 0;
    if (row.market_low_confidence === true || confidenceScore < 45) continue;
    const asOfMs = row.market_price_as_of ? new Date(row.market_price_as_of).getTime() : NaN;
    if (!Number.isFinite(asOfMs) || (Date.now() - asOfMs) > (24 * 60 * 60 * 1000)) continue;
    const sampleCounts7d = row.market_provenance?.sampleCounts7d;
    const sampleSize7d = (toFinite(sampleCounts7d?.justtcg) ?? 0) + (toFinite(sampleCounts7d?.scrydex) ?? 0);
    if (sampleSize7d < 8) continue;
    const activeListings7d = Math.max(0, toFinite(row.active_listings_7d) ?? 0);
    const liquidityWeight = computeLiquidityWeight(activeListings7d);
    const score = changePct * (confidenceScore / 100) * liquidityWeight;
    if (!(score > 0)) continue;
    if (activeListings7d >= 6) highConfidenceScores.push(changePct);
    else if (activeListings7d <= 5) emergingScores.push(changePct);
  }
  highConfidenceScores.sort((a, b) => b - a);
  emergingScores.sort((a, b) => b - a);
  const highConfidenceTop10 = highConfidenceScores.slice(0, 10).sort((a, b) => a - b);
  const emergingTop10 = emergingScores.slice(0, 10).sort((a, b) => a - b);
  const moversHealth = {
    highConfidenceCount: highConfidenceScores.length,
    emergingCount: emergingScores.length,
    highConfidenceTop10MedianAbsChangePct: percentile(highConfidenceTop10, 50),
    emergingTop10MedianAbsChangePct: percentile(emergingTop10, 50),
  };

  function statusHighGood(value: number | null, good: number, warn: number): "healthy" | "warning" | "critical" {
    if (value === null) return "warning";
    if (value >= good) return "healthy";
    if (value >= warn) return "warning";
    return "critical";
  }
  function statusLowGood(value: number | null, goodMax: number, warnMax: number): "healthy" | "warning" | "critical" {
    if (value === null) return "warning";
    if (value <= goodMax) return "healthy";
    if (value <= warnMax) return "warning";
    return "critical";
  }

  const p90Spread = percentile(spreads, 90);
  const freshnessSlo = statusHighGood(under24h > 0 && totalRaw > 0 ? (under24h / totalRaw) * 100 : 0, 90, 80);
  const coverageSlo = statusHighGood(totalRaw > 0 ? (both / totalRaw) * 100 : 0, 60, 45);
  const blendablePct = (blendableMatch !== null && totalRaw > 0) ? (blendableMatch / totalRaw) * 100 : null;
  const agreementSlo = statusLowGood(p90Spread, 45, 70);
  const changeCoverageSlo = statusHighGood(changeCoveragePct, 99.9, 99);
  const sentinelSlo = statusLowGood(sentinelRes.count ?? 0, 0, 5);
  const retrySlo = statusLowGood(retryDepth, 5, 20);
  const alerts: string[] = [];
  const providerObservationCount24h = (just24hObsRes.count ?? 0) + (scrydex24hObsRes.count ?? 0);
  const freshRawCards24h = under24h;
  if (providerObservationCount24h === 0) alerts.push("Hard alert: zero JustTCG/Scrydex snapshot observations in 24h.");
  if (freshRawCards24h === 0) alerts.push("Hard alert: zero fresh RAW cards in 24h.");
  if (freshnessSlo !== "healthy") alerts.push(`Freshness below SLO (${under24h}/${totalRaw} fresh in 24h).`);
  if (coverageSlo !== "healthy") alerts.push(`Dual-provider coverage below SLO (${both}/${totalRaw}).`);
  if (changeCoverageSlo !== "healthy") alerts.push(`Price-change coverage dropped (${changeCoverageCount}/${totalRaw} cards have change_pct).`);
  if (blendablePct !== null && blendablePct < 50) alerts.push(`Blendable parity coverage is low (${blendablePct.toFixed(2)}%).`);
  if (agreementSlo === "critical") alerts.push(`Provider spread is elevated (p90 ${p90Spread ?? 0}%).`);
  if (divergenceGt80PctCount > 50) alerts.push(`Provider divergence spike: ${divergenceGt80PctCount} cards >80% spread.`);
  if (setJumpGt40PctCount > 0) alerts.push(`Set-level jump alert: ${setJumpGt40PctCount} sets have >=40% 24h movers.`);
  if ((moversHealth.highConfidenceTop10MedianAbsChangePct ?? 0) > 0 && (moversHealth.highConfidenceTop10MedianAbsChangePct ?? 0) < 3) {
    alerts.push(`Top movers are muted (top-10 median move ${moversHealth.highConfidenceTop10MedianAbsChangePct?.toFixed(2)}%).`);
  }
  if (zeroChange24hCount > Math.max(100, Math.floor(totalRaw * 0.25))) {
    alerts.push(`Zero-change spike: ${zeroChange24hCount} RAW cards reported 0% 24h change.`);
  }
  if (sentinelSlo !== "healthy") alerts.push(`Sentinel price flags detected (${sentinelRes.count ?? 0}).`);
  if (retrySlo !== "healthy") alerts.push(`Pipeline retry queue depth elevated (${retryDepth ?? 0}).`);

  return {
    asOf,
    snapshotCoverage24h,
    freshnessByProvider24h: providerFreshness,
    coverage: {
      both,
      justtcgOnly,
      scrydexOnly,
      none,
      bothPct: totalRaw > 0 ? Number(((both / totalRaw) * 100).toFixed(2)) : 0,
      blendableMatch,
      blendableMatchPct: blendablePct !== null ? Number(blendablePct.toFixed(2)) : null,
      parityMismatch,
    },
    stalenessBuckets: {
      under6h,
      h6to24: Math.max(0, under24h - under6h),
      d1to3: Math.max(0, under72h - under24h),
      over3d: Math.max(0, withTs - under72h),
      missingTs,
    },
    priceAgreement: {
      comparableCards: spreads.length,
      medianSpreadPct: percentile(spreads, 50),
      p90SpreadPct: p90Spread,
    },
    outlierGuardrails: {
      ratioGte3p5Count,
      ratioGte3p5Pct: spreads.length > 0 ? Number(((ratioGte3p5Count / spreads.length) * 100).toFixed(2)) : null,
    },
    outlierDiagnostics24h: {
      excludedPoints: outlierExcludedPoints24h,
      impactedCards: outlierImpactedCards24h,
    },
    dataQualityFlags: {
      sentinel23456Count: sentinelRes.count ?? 0,
      pricedButMissingTsCount,
    },
    changeCoverage: {
      withChangePctCount: changeCoverageCount,
      withChangePct: changeCoveragePct,
      missingChangePctCount: missingChangeCount,
      missingChangePct,
    },
    ingestionVolume24h: {
      justtcgObservations: just24hObsRes.error ? null : (just24hObsRes.count ?? 0),
      scrydexObservations: scrydex24hObsRes.error ? null : (scrydex24hObsRes.count ?? 0),
    },
    setFreshness24h: {
      stalest,
      freshest,
    },
    pipelineHealth: {
      queueDepth,
      retryDepth,
      failedDepth,
    },
    anomalies: {
      providerDivergenceGt80PctCount: divergenceGt80PctCount,
      zeroChange24hCount,
      nullChange24hCount,
      setJumpGt40PctCount,
    },
    accuracyBacktest,
    moversHealth,
    slo: [
      {
        key: "freshness_24h",
        label: "Freshness (24h)",
        status: freshnessSlo,
        value: `${(under24h > 0 && totalRaw > 0 ? (under24h / totalRaw) * 100 : 0).toFixed(2)}%`,
        target: ">= 90%",
      },
      {
        key: "coverage_both",
        label: "Dual-Provider Coverage",
        status: coverageSlo,
        value: `${(totalRaw > 0 ? (both / totalRaw) * 100 : 0).toFixed(2)}%`,
        target: ">= 60%",
      },
      {
        key: "change_coverage",
        label: "Price Change Coverage",
        status: changeCoverageSlo,
        value: `${changeCoveragePct.toFixed(2)}%`,
        target: ">= 99.9%",
      },
      {
        key: "agreement_p90",
        label: "Agreement p90 Spread",
        status: agreementSlo,
        value: `${(p90Spread ?? 0).toFixed(2)}%`,
        target: "<= 45%",
      },
      {
        key: "sentinel_prices",
        label: "Sentinel Price Flags",
        status: sentinelSlo,
        value: String(sentinelRes.count ?? 0),
        target: "0",
      },
      {
        key: "pipeline_retry_depth",
        label: "Pipeline Retry Depth",
        status: retrySlo,
        value: String(retryDepth ?? 0),
        target: "<= 5",
      },
    ],
    alerts,
  };
}

export async function getPricingTransparencyTrend(days = 7): Promise<PricingTransparencyTrendPoint[]> {
  const supabase = dbPublic();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("pricing_transparency_snapshots")
    .select("captured_at, freshness_pct, coverage_both_pct, p90_spread_pct, queue_depth, retry_depth, failed_depth")
    .gte("captured_at", since)
    .order("captured_at", { ascending: true })
    .limit(300);
  if (error) return [];
  return ((data ?? []) as Array<{
    captured_at: string;
    freshness_pct: number | null;
    coverage_both_pct: number | null;
    p90_spread_pct: number | null;
    queue_depth: number | null;
    retry_depth: number | null;
    failed_depth: number | null;
  }>).map((row) => ({
    capturedAt: row.captured_at,
    freshnessPct: row.freshness_pct,
    coverageBothPct: row.coverage_both_pct,
    p90SpreadPct: row.p90_spread_pct,
    queueDepth: row.queue_depth,
    retryDepth: row.retry_depth,
    failedDepth: row.failed_depth,
  }));
}
