import { NextResponse } from "next/server";
import { choosePreferredRawPricingPrinting, type RawPricingPrinting } from "@/lib/cards/raw-pricing-printing";
import { dbPublic } from "@/lib/db";
import { measureAsync } from "@/lib/perf";
import { filterRawHistoryRowsForPrinting } from "@/lib/pricing/raw-history";
import { buildProviderPriceDisplay } from "@/lib/pricing/provider-price-display";
import {
  computeConfidenceBand,
  resolveWeightedMarketPrice,
  type ObservationInput,
} from "@/lib/pricing/market-confidence";
import { resolveSnapshotTrust } from "@/lib/pricing/snapshot-trust";

export const runtime = "nodejs";

type SnapshotRow = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
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
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
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
      "canonical_slug, printing_id, grade, market_price, market_price_as_of, active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d, market_confidence_score, market_low_confidence, market_blend_policy, market_provenance"
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

  const scrydexSourcePrice = result.data?.market_price ?? null;
  const scrydexAsOf = scrydexSourcePrice !== null ? (result.data?.market_price_as_of ?? null) : null;
  const scrydex = await buildProviderPriceDisplay({
    supabase,
    provider: "SCRYDEX",
    sourcePrice: scrydexSourcePrice,
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
  if (scrydex.usdPrice !== null) {
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
    for (const row of historyRows) {
      const provider = normalizeRawProviderName(row.provider);
      const tsMs = new Date(row.ts).getTime();
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs < Date.now() - 7 * 24 * 60 * 60 * 1000) continue;
      if (provider === "SCRYDEX") pointCounts.scrydex += 1;
    }
  }

  const weighted = resolveWeightedMarketPrice({
    providers: [
      {
        provider: "SCRYDEX",
        price: scrydex.usdPrice,
        asOfTs: scrydex.asOf,
        points7d: pointCounts.scrydex,
      },
    ],
    parityStatus,
    marketPriceFallback: null,
    median7dFallback: null,
  });

  const observations: ObservationInput[] = [];
  for (const row of historyRows) {
    const provider = normalizeRawProviderName(row.provider);
    if (!provider || !Number.isFinite(row.price) || row.price <= 0) continue;
    observations.push({
      provider,
      ts: row.ts,
      price: row.price,
    });
  }

  const confidenceBand = computeConfidenceBand({ observations });

  const modelConfidence = Math.round((weighted.confidenceScore * 0.65) + (confidenceBand.confidenceScore * 0.35));
  const lowConfidence = weighted.lowConfidence || confidenceBand.lowConfidence;

  const marketPriceUsd = scrydex.usdPrice ?? null;
  const marketPriceAsOf = marketPriceUsd !== null ? (scrydex.asOf ?? null) : null;
  const trust = resolveSnapshotTrust(result.data ?? null, {
    blendPolicy: marketPriceUsd !== null ? "SCRYDEX_PRIMARY" : "NO_PRICE",
    confidenceScore: marketPriceUsd !== null ? modelConfidence : 0,
    lowConfidence: marketPriceUsd === null ? true : lowConfidence,
  });

  return NextResponse.json({
    ok: true,
    justtcgPrice: null,
    scrydexPrice: marketPriceUsd,
    pokemontcgPrice: null,
    marketPrice: marketPriceUsd,
    marketPriceAsOf,
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
      sourceMix: {
        justtcgWeight: 0,
        scrydexWeight: marketPriceUsd !== null ? 1 : 0,
      },
      providerWeights: weighted.providerWeights,
      providerDivergencePct: weighted.providerDivergencePct,
      lastUpdate: {
        justtcg: null,
        scrydex: marketPriceUsd !== null ? marketPriceAsOf : null,
      },
      sampleSize30d: marketPriceUsd !== null ? historyRows.length : 0,
      sampleSizeFiltered: marketPriceUsd !== null ? confidenceBand.sampleSize : 0,
    },
    providers: marketPriceUsd !== null ? [scrydex] : [],
    active7d: result.data?.active_listings_7d ?? 0,
    median7d: result.data?.median_7d ?? null,
    median30d: result.data?.median_30d ?? null,
    trimmedMedian30d: result.data?.trimmed_median_30d ?? null,
    low30d: result.data?.low_30d ?? null,
    high30d: result.data?.high_30d ?? null,
  });
}
