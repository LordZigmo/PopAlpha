import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";
import { measureAsync } from "@/lib/perf";
import { buildProviderPriceDisplay } from "@/lib/pricing/provider-price-display";
import {
  computeConfidenceBand,
  resolveWeightedMarketPrice,
  type ObservationInput,
} from "@/lib/pricing/market-confidence";

export const runtime = "nodejs";

type SnapshotRow = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  justtcg_price: number | null;
  scrydex_price: number | null;
  pokemontcg_price?: number | null;
  market_price: number | null;
  market_price_as_of: string | null;
  active_listings_7d: number | null;
  median_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
};

type ProviderAsOfRow = {
  provider: string;
  provider_as_of_ts: string | null;
};

type ProviderHistoryAsOfRow = {
  provider: string;
  ts: string;
  price: number;
  currency: string | null;
};

type ParityRow = {
  parity_status: "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";
};

function normalizeRawProviderName(provider: string | null | undefined): "JUSTTCG" | "SCRYDEX" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "JUSTTCG") return "JUSTTCG";
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
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
  let query = supabase
    .from("public_card_metrics")
    .select(
      "canonical_slug, printing_id, grade, justtcg_price, scrydex_price, pokemontcg_price, market_price, market_price_as_of, active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d"
    )
    .eq("canonical_slug", slug)
    .eq("grade", grade)
    .limit(1);

  query = printing ? query.eq("printing_id", printing) : query.is("printing_id", null);

  const result = await measureAsync("market.snapshot.query", { slug, printing: printing || null, grade }, async () => {
    const metricsResult = await query.maybeSingle<SnapshotRow>();
    return {
      data: metricsResult.data,
      error: metricsResult.error?.message ?? null,
    };
  });

  if (result.error) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  let providerAsOfQuery = supabase
    .from("public_variant_metrics")
    .select("provider, provider_as_of_ts")
    .eq("canonical_slug", slug)
    .eq("grade", grade)
    .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
    .limit(50);

  providerAsOfQuery = printing ? providerAsOfQuery.eq("printing_id", printing) : providerAsOfQuery.is("printing_id", null);
  const providerAsOfResult = await providerAsOfQuery;
  if (providerAsOfResult.error) {
    return NextResponse.json({ ok: false, error: providerAsOfResult.error.message }, { status: 500 });
  }

  let justtcgAsOf: string | null = null;
  let scrydexAsOf: string | null = null;
  for (const row of (providerAsOfResult.data ?? []) as ProviderAsOfRow[]) {
    const provider = normalizeRawProviderName(row.provider);
    const ts = row.provider_as_of_ts;
    if (!provider || !ts) continue;
    if (provider === "JUSTTCG" && (!justtcgAsOf || ts > justtcgAsOf)) justtcgAsOf = ts;
    if (provider === "SCRYDEX" && (!scrydexAsOf || ts > scrydexAsOf)) scrydexAsOf = ts;
  }

  if (grade === "RAW" && (!justtcgAsOf || !scrydexAsOf)) {
    let historyQuery = supabase
      .from("public_price_history")
      .select("provider, ts, price, currency")
      .eq("canonical_slug", slug)
      .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
      .order("ts", { ascending: false })
      .limit(600);
    if (printing) {
      // Accept canonical RAW refs regardless of provider-specific tail segments.
      historyQuery = historyQuery.ilike("variant_ref", `${printing}::%`);
    }
    const historyResult = await historyQuery;
    if (historyResult.error) {
      return NextResponse.json({ ok: false, error: historyResult.error.message }, { status: 500 });
    }
    for (const row of (historyResult.data ?? []) as ProviderHistoryAsOfRow[]) {
      const provider = normalizeRawProviderName(row.provider);
      if (!provider) continue;
      if (provider === "JUSTTCG" && !justtcgAsOf) justtcgAsOf = row.ts;
      if (provider === "SCRYDEX" && !scrydexAsOf) scrydexAsOf = row.ts;
      if (justtcgAsOf && scrydexAsOf) break;
    }
  }

  const justtcgSourcePrice = result.data?.justtcg_price ?? null;
  const scrydexSourcePrice = result.data?.scrydex_price ?? result.data?.pokemontcg_price ?? null;
  const justtcg = await buildProviderPriceDisplay({
    supabase,
    provider: "JUSTTCG",
    sourcePrice: justtcgSourcePrice,
    sourceCurrency: "USD",
    asOf: justtcgSourcePrice != null ? justtcgAsOf : null,
  });
  const scrydex = await buildProviderPriceDisplay({
    supabase,
    provider: "SCRYDEX",
    sourcePrice: scrydexSourcePrice,
    sourceCurrency: "USD",
    asOf: scrydexSourcePrice != null ? (scrydexAsOf ?? result.data?.market_price_as_of ?? null) : null,
  });
  const { data: parityData } = await supabase
    .from("canonical_raw_provider_parity")
    .select("parity_status")
    .eq("canonical_slug", slug)
    .maybeSingle<ParityRow>();
  const parityStatus = parityData?.parity_status ?? "UNKNOWN";

  const pointCounts = { justtcg: 0, scrydex: 0 };
  for (const row of (providerAsOfResult.data ?? []) as ProviderAsOfRow[]) {
    const provider = normalizeRawProviderName(row.provider);
    if (provider === "JUSTTCG") pointCounts.justtcg += 1;
    if (provider === "SCRYDEX") pointCounts.scrydex += 1;
  }
  let historyRows: ProviderHistoryAsOfRow[] = [];
  if (grade === "RAW") {
    let historyRowsQuery = supabase
      .from("public_price_history")
      .select("provider, ts, price, currency")
      .eq("canonical_slug", slug)
      .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
      .eq("source_window", "snapshot")
      .gte("ts", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(800);
    if (printing) historyRowsQuery = historyRowsQuery.ilike("variant_ref", `${printing}::%`);
    const historyRowsResult = await historyRowsQuery;
    if (historyRowsResult.error) {
      return NextResponse.json({ ok: false, error: historyRowsResult.error.message }, { status: 500 });
    }
    historyRows = (historyRowsResult.data ?? []) as ProviderHistoryAsOfRow[];
  }
  for (const row of historyRows) {
    const provider = normalizeRawProviderName(row.provider);
    const tsMs = new Date(row.ts).getTime();
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < Date.now() - 7 * 24 * 60 * 60 * 1000) continue;
    if (provider === "JUSTTCG") pointCounts.justtcg += 1;
    if (provider === "SCRYDEX") pointCounts.scrydex += 1;
  }

  const weighted = resolveWeightedMarketPrice({
    providers: [
      {
        provider: "JUSTTCG",
        price: justtcg.usdPrice,
        asOfTs: justtcg.asOf,
        points7d: pointCounts.justtcg,
      },
      {
        provider: "SCRYDEX",
        price: scrydex.usdPrice,
        asOfTs: scrydex.asOf,
        points7d: pointCounts.scrydex,
      },
    ],
    parityStatus,
    marketPriceFallback: result.data?.market_price ?? null,
    median7dFallback: result.data?.median_7d ?? null,
  });

  const confidenceBand = computeConfidenceBand({
    observations: historyRows
      .map((row) => {
        const provider = normalizeRawProviderName(row.provider);
        return {
          provider,
          ts: row.ts,
          price: row.price,
        };
      })
      .filter((row): row is ObservationInput => Boolean(row.provider) && Number.isFinite(row.price) && row.price > 0),
  });

  const modelConfidence = Math.round((weighted.confidenceScore * 0.65) + (confidenceBand.confidenceScore * 0.35));
  const lowConfidence = weighted.lowConfidence || confidenceBand.lowConfidence;

  const marketPriceUsd = weighted.marketPrice ?? confidenceBand.fairValue ?? result.data?.market_price ?? null;
  const marketPriceAsOf = [justtcg.asOf, scrydex.asOf].filter(Boolean).sort().at(-1) ?? result.data?.market_price_as_of ?? null;

  return NextResponse.json({
    ok: true,
    justtcgPrice: justtcg.usdPrice,
    scrydexPrice: scrydex.usdPrice,
    pokemontcgPrice: scrydex.usdPrice,
    marketPrice: marketPriceUsd,
    marketPriceAsOf,
    parityStatus,
    blendPolicy: weighted.blendPolicy,
    confidenceScore: modelConfidence,
    lowConfidence,
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
      sourceMix: weighted.sourceMix,
      providerWeights: weighted.providerWeights,
      providerDivergencePct: weighted.providerDivergencePct,
      lastUpdate: {
        justtcg: justtcg.asOf,
        scrydex: scrydex.asOf,
      },
      sampleSize30d: historyRows.length,
      sampleSizeFiltered: confidenceBand.sampleSize,
    },
    providers: [justtcg, scrydex],
    active7d: result.data?.active_listings_7d ?? 0,
    median7d: result.data?.median_7d ?? null,
    median30d: result.data?.median_30d ?? null,
    trimmedMedian30d: result.data?.trimmed_median_30d ?? null,
    low30d: result.data?.low_30d ?? null,
    high30d: result.data?.high_30d ?? null,
  });
}
