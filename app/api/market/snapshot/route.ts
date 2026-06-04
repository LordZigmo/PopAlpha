import { NextResponse } from "next/server";
import { choosePreferredRawPricingPrinting, type RawPricingPrinting } from "@/lib/cards/raw-pricing-printing";
import { dbPublic } from "@/lib/db";
import { measureAsync } from "@/lib/perf";
import { filterRawHistoryRowsForPrinting } from "@/lib/pricing/raw-history";
import { buildProviderPriceDisplay } from "@/lib/pricing/provider-price-display";
import {
  convertPriceHistoryRowToUsd,
  loadPriceHistoryFxRows,
} from "@/lib/pricing/price-history-currency";
import {
  computeConfidenceBand,
  resolveWeightedMarketPrice,
  type ObservationInput,
  type WeightedMarketPriceResult,
} from "@/lib/pricing/market-confidence";
import { resolveSnapshotTrust } from "@/lib/pricing/snapshot-trust";

export const runtime = "nodejs";

type SnapshotRow = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  scrydex_price: number | null;
  market_price: number | null;
  market_price_as_of: string | null;
  active_listings_7d: number | null;
  median_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  market_confidence_score: number | null;
  market_low_confidence: boolean | null;
  market_blend_policy: string | null;
  market_provenance: Record<string, unknown> | null;
  market_price_display_state: string | null;
  recent_market_signal_usd: number | null;
  recent_market_signal_as_of: string | null;
  recent_market_signal_delta_pct: number | null;
  recent_market_signal_direction: "HIGHER" | "LOWER" | null;
};

type ProviderHistoryAsOfRow = {
  provider: string;
  variant_ref: string | null;
  ts: string;
  price: number;
  currency: string | null;
};

type ParityRow = {
  parity_status: "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";
};

function normalizeRawProviderName(provider: string | null | undefined): "SCRYDEX" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  // POKEMON_TCG_API is a historical compatible provider label in older
  // history rows. Public copy stays neutral and provider names remain legacy
  // compatibility fields only.
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
}

type TrustedMarketProvenance = {
  trustStatus?: string | null;
  confidenceStatus?: string | null;
  publicInputStatus?: string | null;
  sourceMix?: Record<string, unknown> | null;
};

const GRADED_GRADES = new Set(["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"]);

/**
 * Pick the headline price for the snapshot based on grade.
 *
 * RAW headline uses public_card_metrics.market_price, which is now the
 * conservative PopAlpha Market Price anchor. Recent public signals travel in
 * separate recentMarketSignal* fields.
 *
 * Graded card_metrics rows have market_price = NULL — the refresh
 * function doesn't compute a "market price" for graded SKUs because the
 * (provider × bucket) fan-out lives in variant_metrics. card_metrics
 * does carry `median_30d` / `trimmed_median_30d` for graded though,
 * computed from the same chart-feeding snapshots. Fall back to those
 * for the graded headline so the snapshot route stops returning a null
 * price for cards that obviously have one (Celebrations Claydol G10
 * shows trimmed_median_30d = $53.54 with 12 active listings, but the
 * old code returned price=null because market_price was empty).
 *
 * Phase 3 of docs/graded-surfacing-plan.md (shipped 2026-05-16).
 */
function pickHeadlineSourcePrice(
  grade: string,
  snapshot: SnapshotRow | null,
): number | null {
  if (!snapshot) return null;
  if (grade === "RAW") return snapshot.market_price ?? null;
  if (!GRADED_GRADES.has(grade)) return snapshot.market_price ?? null;
  return snapshot.trimmed_median_30d ?? snapshot.median_30d ?? null;
}

async function resolveRawPricingPrintingId(params: {
  supabase: ReturnType<typeof dbPublic>;
  slug: string;
  explicitPrintingId: string | null;
}): Promise<string | null> {
  if (params.explicitPrintingId) return params.explicitPrintingId;

  const { data, error } = await params.supabase
    .from("card_printings")
    .select("id, language, edition, stamp, finish, updated_at")
    .eq("canonical_slug", params.slug)
    .returns<RawPricingPrinting[]>();

  if (error) throw new Error(error.message);
  return choosePreferredRawPricingPrinting(data ?? [])?.id ?? null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const printing = url.searchParams.get("printing")?.trim() ?? "";
  const grade = (url.searchParams.get("grade")?.trim() ?? "RAW").toUpperCase();
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing slug query param." }, { status: 400 });
  }

  const supabase = dbPublic();
  let rawPricingPrintingId: string | null = null;
  try {
    rawPricingPrintingId = grade === "RAW"
      ? await resolveRawPricingPrintingId({
        supabase,
        slug,
        explicitPrintingId: printing || null,
      })
      : null;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to resolve RAW pricing printing." },
      { status: 500 },
    );
  }

  const metricsPrintingId = grade === "RAW" ? (printing ? rawPricingPrintingId : null) : (printing || null);
  let query = supabase
    .from("public_card_metrics")
    .select(
      "canonical_slug, printing_id, grade, scrydex_price, market_price, market_price_as_of, active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d, market_confidence_score, market_low_confidence, market_blend_policy, market_provenance, market_price_display_state, recent_market_signal_usd, recent_market_signal_as_of, recent_market_signal_delta_pct, recent_market_signal_direction"
    )
    .eq("canonical_slug", slug)
    .eq("grade", grade)
    .limit(1);

  query = metricsPrintingId ? query.eq("printing_id", metricsPrintingId) : query.is("printing_id", null);

  const result = await measureAsync("market.snapshot.query", { slug, printing: metricsPrintingId, grade }, async () => {
    const metricsResult = await query.maybeSingle<SnapshotRow>();
    return {
      data: metricsResult.data,
      error: metricsResult.error?.message ?? null,
    };
  });

  if (result.error) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  // Phase 3 of graded-surfacing-plan: pickHeadlineSourcePrice falls
  // back to median_30d for graded grades where card_metrics.market_price
  // is null (graded SKUs don't have a single "market price" because the
  // provider × bucket fan-out lives in variant_metrics). Without this
  // fall-back the route returned null for every graded request even
  // though the chart shows real prices.
  const marketProvenance = (result.data?.market_provenance ?? null) as TrustedMarketProvenance | null;
  const headlineProvider = "SCRYDEX";
  const providerPolicy = result.data?.market_blend_policy
    ?? marketProvenance?.trustStatus
    ?? (grade === "RAW" ? "POPALPHA_MARKET_LOW_CONFIDENCE" : "SCRYDEX_GRADED_MEDIAN");
  const headlineSourcePrice = pickHeadlineSourcePrice(grade, result.data ?? null);
  // RAW carries a real as_of from market_price_as_of. Graded medians are
  // a rolling 30-day computation with no clean "as of" stamp — defer
  // marketPriceAsOf to after the history fetch so we can use the most
  // recent history row's ts instead. Until then, hold the RAW value.
  const scrydexAsOf =
    grade === "RAW" && headlineSourcePrice !== null
      ? (result.data?.market_price_as_of ?? null)
      : null;
  const headlineProviderDisplay = await buildProviderPriceDisplay({
    supabase,
    provider: headlineProvider,
    sourcePrice: headlineSourcePrice,
    sourceCurrency: "USD",
    asOf: scrydexAsOf,
  });
  const { data: parityData } = await supabase
    .from("canonical_raw_provider_parity")
    .select("parity_status")
    .eq("canonical_slug", slug)
    .maybeSingle<ParityRow>();
  const parityStatus = parityData?.parity_status ?? "UNKNOWN";

  const pointCounts = { scrydex: 0 };
  let historyRows: ProviderHistoryAsOfRow[] = [];
  const observations: ObservationInput[] = [];
  if (headlineProviderDisplay.usdPrice !== null && headlineProvider === "SCRYDEX") {
    let historyRowsQuery = supabase
      .from("public_price_history")
      .select("provider, variant_ref, ts, price, currency")
      .eq("canonical_slug", slug)
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .eq("source_window", "snapshot")
      .gte("ts", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(800);
    if (grade === "RAW") {
      if (rawPricingPrintingId) {
        historyRowsQuery = historyRowsQuery.ilike("variant_ref", `${rawPricingPrintingId}::%`);
      } else {
        historyRowsQuery = historyRowsQuery.not("variant_ref", "ilike", "%::GRADED::%");
      }
    } else {
      // Graded chart: match the long-format variant_ref tail
      // `::GRADED::%::${bucket}::RAW` — aggregate across providers at
      // that bucket since card_metrics is per-bucket without a
      // provider dimension. Caller can scope to a specific printing
      // via ?printing=, which becomes a leading prefix match.
      const tail = `%::GRADED::%::${grade}::RAW`;
      historyRowsQuery = historyRowsQuery.ilike(
        "variant_ref",
        printing ? `${printing}::${tail.slice(1)}` : tail,
      );
    }
    const historyRowsResult = await historyRowsQuery;
    if (historyRowsResult.error) {
      return NextResponse.json({ ok: false, error: historyRowsResult.error.message }, { status: 500 });
    }
    const loadedHistoryRows = (historyRowsResult.data ?? []) as ProviderHistoryAsOfRow[];
    historyRows = grade === "RAW"
      ? filterRawHistoryRowsForPrinting(loadedHistoryRows, rawPricingPrintingId)
      : loadedHistoryRows;
    const maxHistoryDate = historyRows
      .map((row) => {
        const date = new Date(row.ts);
        return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
      })
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const fxRows = await loadPriceHistoryFxRows(supabase, maxHistoryDate);
    for (const row of historyRows) {
      const provider = normalizeRawProviderName(row.provider);
      const priceUsd = convertPriceHistoryRowToUsd(row, fxRows);
      if (!provider || priceUsd === null || priceUsd <= 0) continue;
      const tsMs = new Date(row.ts).getTime();
      if (Number.isFinite(tsMs) && tsMs >= Date.now() - 7 * 24 * 60 * 60 * 1000 && provider === "SCRYDEX") {
        pointCounts.scrydex += 1;
      }
      observations.push({
        provider,
        ts: row.ts,
        price: priceUsd,
      });
    }
  }

  const weighted: WeightedMarketPriceResult = resolveWeightedMarketPrice({
    providers: [
      {
        provider: "SCRYDEX",
        price: headlineProviderDisplay.usdPrice,
        asOfTs: headlineProviderDisplay.asOf,
        points7d: pointCounts.scrydex,
      },
    ],
    parityStatus,
    marketPriceFallback: null,
    median7dFallback: null,
  });

  const confidenceBand = computeConfidenceBand({ observations });

  const modelConfidence = Math.round((weighted.confidenceScore * 0.65) + (confidenceBand.confidenceScore * 0.35));
  const lowConfidence = weighted.lowConfidence || confidenceBand.lowConfidence;

  const marketPriceUsd = headlineProviderDisplay.usdPrice ?? null;
  // Compute marketPriceAsOf:
  //   - RAW: use the existing market_price_as_of stamp (real "last sold").
  //   - Graded: median_30d has no clean as_of, so use the most recent
  //     history row's ts as a "last refreshed" proxy. Falls back to
  //     null if no history rows landed.
  let marketPriceAsOf: string | null = marketPriceUsd !== null ? (headlineProviderDisplay.asOf ?? null) : null;
  if (marketPriceUsd !== null && marketPriceAsOf === null && historyRows.length > 0) {
    let latestMs = -Infinity;
    let latestIso: string | null = null;
    for (const row of historyRows) {
      const ms = new Date(row.ts).getTime();
      if (Number.isFinite(ms) && ms > latestMs) {
        latestMs = ms;
        latestIso = row.ts;
      }
    }
    marketPriceAsOf = latestIso;
  }
  // Synthesize a trust row keyed to the chosen headline price.
  // resolveSnapshotTrust reads row.market_price internally and short-
  // circuits to NO_PRICE/0/lowConfidence=true when null. For graded
  // requests `result.data.market_price` is always null (the refresh
  // function doesn't compute a single "market price" for graded SKUs),
  // but we've computed a real headline from the median fall-back. Pass
  // the resolved headline as market_price on the synth row so the
  // trust resolver takes the non-null branch and uses our fallback
  // confidenceScore / lowConfidence / blendPolicy instead of the
  // NO_PRICE short-circuit. Codex P2 on PR #105.
  const trustRow = result.data
    ? { ...result.data, market_price: marketPriceUsd }
    : marketPriceUsd !== null
      ? {
          market_price: marketPriceUsd,
          market_confidence_score: null,
          market_low_confidence: null,
          market_blend_policy: null,
        }
      : null;
  const trust = resolveSnapshotTrust(trustRow, {
    blendPolicy: marketPriceUsd !== null
      ? (grade === "RAW" ? providerPolicy : "SCRYDEX_GRADED_MEDIAN")
      : "NO_PRICE",
    confidenceScore: marketPriceUsd !== null ? modelConfidence : 0,
    lowConfidence: marketPriceUsd === null ? true : lowConfidence,
  });

  return NextResponse.json({
    ok: true,
    providerPolicy,
    priceObservationCount7d: result.data?.active_listings_7d ?? 0,
    deprecatedProviderFields: ["pokemontcgPrice", "active7d"],
    scrydexPrice: result.data?.scrydex_price ?? (headlineProvider === "SCRYDEX" ? marketPriceUsd : null),
    pokemontcgPrice: null,
    marketPrice: marketPriceUsd,
    marketPriceAsOf,
    marketPriceDisplayState: result.data?.market_price_display_state ?? (marketPriceUsd !== null ? "ALIGNED" : "NO_RELIABLE_PRICE"),
    recentMarketSignalUsd: result.data?.recent_market_signal_usd ?? null,
    recentMarketSignalAsOf: result.data?.recent_market_signal_as_of ?? null,
    recentMarketSignalDeltaPct: result.data?.recent_market_signal_delta_pct ?? null,
    recentMarketSignalDirection: result.data?.recent_market_signal_direction ?? null,
    parityStatus,
    blendPolicy: trust.blendPolicy,
    confidenceScore: trust.confidenceScore,
    lowConfidence: trust.lowConfidence,
    confidenceBand: {
      low: confidenceBand.low,
      fairValue: confidenceBand.fairValue,
      high: confidenceBand.high,
      spreadPct: confidenceBand.spreadPct,
      sampleSize: confidenceBand.sampleSize,
      excludedPoints: confidenceBand.excludedPoints,
      excludedSample: confidenceBand.excluded.slice(0, 20),
    },
    provenance: {
      primaryProvider: marketPriceUsd !== null ? headlineProvider : null,
      providerPolicy,
      historicalAliases: ["POKEMON_TCG_API"],
      sourceMix: marketProvenance?.sourceMix ?? {
        scrydexWeight: marketPriceUsd !== null ? 1 : 0,
      },
      providerWeights: weighted.providerWeights,
      providerDivergencePct: weighted.providerDivergencePct,
      lastUpdate: {
        scrydex: marketPriceUsd !== null ? marketPriceAsOf : null,
      },
      sampleSize30d: marketPriceUsd !== null ? historyRows.length : 0,
      sampleSizeFiltered: marketPriceUsd !== null ? confidenceBand.sampleSize : 0,
    },
    providers: marketPriceUsd !== null ? [headlineProviderDisplay] : [],
    // Deprecated name retained for API compatibility. This is a count of
    // recent price observations, not live marketplace listings.
    active7d: result.data?.active_listings_7d ?? 0,
    median7d: result.data?.median_7d ?? null,
    median30d: result.data?.median_30d ?? null,
    trimmedMedian30d: result.data?.trimmed_median_30d ?? null,
    low30d: result.data?.low_30d ?? null,
    high30d: result.data?.high_30d ?? null,
  });
}
