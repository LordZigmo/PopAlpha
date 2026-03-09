export type RawParityStatus = "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";

export type ProviderKey = "JUSTTCG" | "SCRYDEX";

export type ProviderInput = {
  provider: ProviderKey;
  price: number | null;
  asOfTs?: string | null;
  points7d?: number | null;
};

export type ProviderWeight = {
  provider: ProviderKey;
  weight: number;
  trustScore: number;
  freshnessHours: number | null;
  points7d: number;
  excludedReason: "STALE" | "OUTLIER" | null;
};

export type ObservationInput = {
  provider: ProviderKey;
  ts: string;
  price: number;
};

export type ExcludedObservation = {
  provider: ProviderKey;
  ts: string;
  price: number;
  reason: "MAD" | "IQR";
};

export type ConfidenceBandResult = {
  fairValue: number | null;
  low: number | null;
  high: number | null;
  confidenceScore: number;
  lowConfidence: boolean;
  sampleSize: number;
  excludedPoints: number;
  excluded: ExcludedObservation[];
  spreadPct: number | null;
};

export type WeightedMarketPriceResult = {
  marketPrice: number | null;
  blendPolicy:
    | "NO_PRICE"
    | "SCRYDEX_PRIMARY"
    | "SINGLE_PROVIDER"
    | "FALLBACK_STALE_OR_OUTLIER";
  providerWeights: ProviderWeight[];
  confidenceScore: number;
  lowConfidence: boolean;
  sourceMix: {
    justtcgWeight: number;
    scrydexWeight: number;
  };
  providerDivergencePct: number | null;
};

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * sorted.length)));
  return sorted[idx] ?? null;
}

function weightedQuantile(values: Array<{ value: number; weight: number }>, q: number): number | null {
  if (values.length === 0) return null;
  const clean = values
    .filter((row) => row.value > 0 && Number.isFinite(row.value) && row.weight > 0 && Number.isFinite(row.weight))
    .sort((a, b) => a.value - b.value);
  if (clean.length === 0) return null;

  const total = clean.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return null;
  const target = total * Math.min(1, Math.max(0, q));

  let cumulative = 0;
  for (const row of clean) {
    cumulative += row.weight;
    if (cumulative >= target) return row.value;
  }
  return clean.at(-1)?.value ?? null;
}

function toFreshnessHours(asOfTs: string | null | undefined, nowMs: number): number | null {
  if (!asOfTs) return null;
  const ms = new Date(asOfTs).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (nowMs - ms) / (60 * 60 * 1000));
}

function freshnessFactor(hours: number | null): number {
  if (hours === null) return 0.55;
  if (hours <= 3) return 1;
  if (hours <= 6) return 0.95;
  if (hours <= 24) return 0.85;
  if (hours <= 72) return 0.6;
  if (hours <= 168) return 0.35;
  return 0.15;
}

function volumeFactor(points7d: number): number {
  if (points7d <= 0) return 0.4;
  if (points7d >= 80) return 1;
  return 0.4 + (points7d / 80) * 0.6;
}

function robustFilterPrices<T extends ObservationInput>(points: T[]): { kept: T[]; excluded: ExcludedObservation[] } {
  if (points.length < 5) return { kept: points, excluded: [] };

  const prices = points.map((p) => p.price).sort((a, b) => a - b);
  const median = percentile(prices, 50);
  if (!median || median <= 0) return { kept: points, excluded: [] };

  const absDeviations = prices.map((p) => Math.abs(p - median)).sort((a, b) => a - b);
  const mad = percentile(absDeviations, 50) ?? 0;
  const madFloor = Math.max(mad * 1.4826, median * 0.02);
  const madLimit = madFloor * 4.5;

  const q1 = percentile(prices, 25) ?? median;
  const q3 = percentile(prices, 75) ?? median;
  const iqr = Math.max(0, q3 - q1);
  const iqrLow = q1 - iqr * 1.5;
  const iqrHigh = q3 + iqr * 1.5;

  const kept: T[] = [];
  const excluded: ExcludedObservation[] = [];

  for (const point of points) {
    const byMad = Math.abs(point.price - median) > madLimit;
    const byIqr = point.price < iqrLow || point.price > iqrHigh;
    if (byMad || byIqr) {
      excluded.push({
        provider: point.provider,
        ts: point.ts,
        price: point.price,
        reason: byMad ? "MAD" : "IQR",
      });
      continue;
    }
    kept.push(point);
  }

  return { kept, excluded };
}

export function computeConfidenceBand(params: {
  observations: ObservationInput[];
  nowIso?: string;
  halfLifeHours?: number;
}): ConfidenceBandResult {
  const nowMs = new Date(params.nowIso ?? new Date().toISOString()).getTime();
  const halfLifeHours = params.halfLifeHours ?? 72;

  type ObservationWithTs = ObservationInput & { tsMs: number };
  const observations: ObservationWithTs[] = params.observations
    .map((row) => {
      const tsMs = new Date(row.ts).getTime();
      return {
        ...row,
        tsMs,
      };
    })
    .filter((row): row is ObservationWithTs => Number.isFinite(row.tsMs) && row.price > 0 && Number.isFinite(row.price));

  if (observations.length === 0) {
    return {
      fairValue: null,
      low: null,
      high: null,
      confidenceScore: 0,
      lowConfidence: true,
      sampleSize: 0,
      excludedPoints: 0,
      excluded: [],
      spreadPct: null,
    };
  }

  const { kept, excluded } = robustFilterPrices(observations);
  const weighted = kept.map((row) => {
    const ageHours = Math.max(0, (nowMs - row.tsMs) / (60 * 60 * 1000));
    const recencyWeight = Math.pow(0.5, ageHours / halfLifeHours);
    return {
      value: row.price,
      weight: Math.max(0.05, recencyWeight),
    };
  });

  const fairValue = weightedQuantile(weighted, 0.5);
  const low = weightedQuantile(weighted, 0.25);
  const high = weightedQuantile(weighted, 0.75);
  const spreadPct = fairValue && fairValue > 0 && low && high
    ? ((high - low) / fairValue) * 100
    : null;

  const sampleScore = Math.min(1, kept.length / 25);
  const exclusionPenalty = Math.min(0.35, excluded.length / Math.max(1, observations.length));
  const spreadPenalty = spreadPct == null ? 0.25 : Math.min(0.4, spreadPct / 160);
  const confidence = Math.max(0, Math.min(1, sampleScore - exclusionPenalty - spreadPenalty));
  const confidenceScore = Math.round(confidence * 100);

  return {
    fairValue: fairValue != null ? round(fairValue, 4) : null,
    low: low != null ? round(low, 4) : null,
    high: high != null ? round(high, 4) : null,
    confidenceScore,
    lowConfidence: confidenceScore < 45 || kept.length < 5,
    sampleSize: kept.length,
    excludedPoints: excluded.length,
    excluded,
    spreadPct: spreadPct != null ? round(spreadPct, 2) : null,
  };
}

export function resolveWeightedMarketPrice(params: {
  providers: ProviderInput[];
  parityStatus: RawParityStatus;
  marketPriceFallback?: number | null;
  median7dFallback?: number | null;
  nowIso?: string;
}): WeightedMarketPriceResult {
  const nowMs = new Date(params.nowIso ?? new Date().toISOString()).getTime();
  const providers = params.providers
    .map((row) => ({
      ...row,
      price: finite(row.price),
    }))
    .filter((row) => row.price !== null && row.price > 0) as Array<ProviderInput & { price: number }>;

  if (providers.length === 0) {
    const fallback = finite(params.marketPriceFallback) ?? finite(params.median7dFallback);
    return {
      marketPrice: fallback,
      blendPolicy: fallback == null ? "NO_PRICE" : "SINGLE_PROVIDER",
      providerWeights: [],
      confidenceScore: fallback == null ? 0 : 20,
      lowConfidence: true,
      sourceMix: { justtcgWeight: 0, scrydexWeight: 0 },
      providerDivergencePct: null,
    };
  }

  const byProvider = new Map<ProviderKey, ProviderInput & { price: number }>();
  for (const row of providers) {
    byProvider.set(row.provider, row);
  }
  const just = byProvider.get("JUSTTCG") ?? null;
  const scry = byProvider.get("SCRYDEX") ?? null;

  let divergencePct: number | null = null;
  let outlierProvider: ProviderKey | null = null;
  if (just && scry) {
    const mean = (just.price + scry.price) / 2;
    divergencePct = mean > 0 ? (Math.abs(just.price - scry.price) / mean) * 100 : null;
    const high = Math.max(just.price, scry.price);
    const low = Math.min(just.price, scry.price);
    if (low > 0 && high / low >= 3.5) {
      outlierProvider = just.price > scry.price ? "JUSTTCG" : "SCRYDEX";
    }
  }

  const weights: ProviderWeight[] = providers.map((row) => {
    const freshnessHours = toFreshnessHours(row.asOfTs ?? null, nowMs);
    const points7d = Math.max(0, Math.floor(finite(row.points7d) ?? 0));

    const fresh = freshnessFactor(freshnessHours);
    const volume = volumeFactor(points7d);
    const parityFactor = params.parityStatus === "MATCH" ? 1 : params.parityStatus === "UNKNOWN" ? 0.92 : 0.72;
    const divergenceFactor = divergencePct == null ? 1 : Math.max(0.25, 1 - Math.min(0.75, divergencePct / 220));
    const base = row.provider === "JUSTTCG" ? 1 : 0.96;

    let trust = base * fresh * volume * parityFactor * divergenceFactor;
    let excludedReason: ProviderWeight["excludedReason"] = null;
    if (freshnessHours != null && freshnessHours > 168) {
      trust *= 0.05;
      excludedReason = "STALE";
    }
    if (outlierProvider && row.provider === outlierProvider) {
      trust *= 0.03;
      excludedReason = excludedReason ?? "OUTLIER";
    }

    return {
      provider: row.provider,
      weight: trust,
      trustScore: Math.round(Math.max(0, Math.min(1, trust)) * 100),
      freshnessHours: freshnessHours != null ? round(freshnessHours, 2) : null,
      points7d,
      excludedReason,
    };
  });

  const totalWeight = weights.reduce((sum, row) => sum + row.weight, 0);
  const fallbackPrice = finite(params.marketPriceFallback) ?? finite(params.median7dFallback);

  let marketPrice: number | null = null;
  let blendPolicy: WeightedMarketPriceResult["blendPolicy"] = "NO_PRICE";
  const normalizedWeights = totalWeight > 0
    ? weights.map((row) => ({ ...row, weight: row.weight / totalWeight }))
    : weights.map((row) => ({ ...row, weight: 0 }));
  const scrydexWeight = normalizedWeights.find((row) => row.provider === "SCRYDEX") ?? null;
  const justtcgWeight = normalizedWeights.find((row) => row.provider === "JUSTTCG") ?? null;
  const scrydexPreferred = scry && scrydexWeight?.excludedReason == null;
  const justtcgPreferred = just && justtcgWeight?.excludedReason == null;

  if (scry && scrydexPreferred) {
    marketPrice = scry.price;
    blendPolicy = "SCRYDEX_PRIMARY";
  } else if (just && justtcgPreferred) {
    marketPrice = just.price;
    blendPolicy = scry ? "FALLBACK_STALE_OR_OUTLIER" : "SINGLE_PROVIDER";
  } else if (scry) {
    marketPrice = scry.price;
    blendPolicy = "FALLBACK_STALE_OR_OUTLIER";
  } else if (just) {
    marketPrice = just.price;
    blendPolicy = "SINGLE_PROVIDER";
  } else if (fallbackPrice != null) {
    marketPrice = fallbackPrice;
    blendPolicy = "FALLBACK_STALE_OR_OUTLIER";
  }

  const justWeight = justtcgWeight?.weight ?? 0;
  const scrydexMix = scrydexWeight?.weight ?? 0;

  const availabilityScore = providers.length === 2 ? 1 : 0.55;
  const freshnessScore = normalizedWeights.reduce((sum, row) => {
    const fresh = 1 - Math.min(1, (row.freshnessHours ?? 36) / 168);
    return sum + row.weight * fresh;
  }, 0);
  const agreementScore = divergencePct == null ? 0.5 : Math.max(0, 1 - Math.min(1, divergencePct / 120));
  const parityScore = params.parityStatus === "MATCH" ? 1 : params.parityStatus === "UNKNOWN" ? 0.7 : 0.4;

  const confidence =
    availabilityScore * 0.25 +
    freshnessScore * 0.25 +
    agreementScore * 0.3 +
    parityScore * 0.2;

  const confidenceScore = Math.round(Math.max(0, Math.min(1, confidence)) * 100);

  return {
    marketPrice,
    blendPolicy,
    providerWeights: normalizedWeights.map((row) => ({
      ...row,
      weight: round(row.weight, 4),
    })),
    confidenceScore,
    lowConfidence: confidenceScore < 45 || (providers.length === 1 && !scry),
    sourceMix: {
      justtcgWeight: round(justWeight, 4),
      scrydexWeight: round(scrydexMix, 4),
    },
    providerDivergencePct: divergencePct != null ? round(divergencePct, 2) : null,
  };
}
