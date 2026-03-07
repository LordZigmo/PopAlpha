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
  dataQualityFlags: {
    sentinel23456Count: number;
    pricedButMissingTsCount: number;
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
};

function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length)));
  return Number(sorted[idx].toFixed(2));
}

export async function getPricingTransparencySnapshot(): Promise<PricingTransparencySnapshot> {
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

  // Provider freshness (distinct canonical cards via canonical RAW variant metrics rows).
  let providerFreshness = { justtcgPct: null as number | null, scrydexPct: null as number | null };
  const providerRowsRes = await supabase
    .from("public_variant_metrics")
    .select("provider, canonical_slug, provider_as_of_ts")
    .eq("grade", "RAW")
    .is("printing_id", null)
    .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
    .limit(10000);
  if (!providerRowsRes.error) {
    const latest = new Map<string, { justtcg: string | null; scrydex: string | null }>();
    for (const row of (providerRowsRes.data ?? []) as Array<{ provider: string; canonical_slug: string; provider_as_of_ts: string | null }>) {
      const slug = row.canonical_slug;
      if (!slug) continue;
      const bucket = latest.get(slug) ?? { justtcg: null, scrydex: null };
      if (row.provider === "JUSTTCG" && row.provider_as_of_ts && (!bucket.justtcg || row.provider_as_of_ts > bucket.justtcg)) {
        bucket.justtcg = row.provider_as_of_ts;
      }
      if ((row.provider === "SCRYDEX" || row.provider === "POKEMON_TCG_API") && row.provider_as_of_ts && (!bucket.scrydex || row.provider_as_of_ts > bucket.scrydex)) {
        bucket.scrydex = row.provider_as_of_ts;
      }
      latest.set(slug, bucket);
    }
    const all = [...latest.values()];
    const jFresh = all.filter((r) => r.justtcg && r.justtcg >= iso24h).length;
    const sFresh = all.filter((r) => r.scrydex && r.scrydex >= iso24h).length;
    if (all.length > 0) {
      providerFreshness = {
        justtcgPct: Number(((jFresh / all.length) * 100).toFixed(2)),
        scrydexPct: Number(((sFresh / all.length) * 100).toFixed(2)),
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
  for (const row of pairs) {
    const a = row.justtcg_price;
    const b = row.scrydex_price;
    if (!(a > 0 && b > 0)) continue;
    const mean = (a + b) / 2;
    spreads.push((Math.abs(a - b) / mean) * 100);
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    if (low > 0 && high / low >= 3.5) ratioGte3p5Count += 1;
  }
  spreads.sort((a, b) => a - b);

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

  return {
    asOf,
    freshnessByProvider24h: providerFreshness,
    coverage: {
      both,
      justtcgOnly,
      scrydexOnly,
      none,
      bothPct: totalRaw > 0 ? Number(((both / totalRaw) * 100).toFixed(2)) : 0,
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
      p90SpreadPct: percentile(spreads, 90),
    },
    outlierGuardrails: {
      ratioGte3p5Count,
      ratioGte3p5Pct: spreads.length > 0 ? Number(((ratioGte3p5Count / spreads.length) * 100).toFixed(2)) : null,
    },
    dataQualityFlags: {
      sentinel23456Count: sentinelRes.count ?? 0,
      pricedButMissingTsCount,
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
  };
}
