import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";
import { measureAsync } from "@/lib/perf";
import { averageProviderUsdPrice, buildProviderPriceDisplay } from "@/lib/pricing/provider-price-display";

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

  const justtcg = await buildProviderPriceDisplay({
    supabase,
    provider: "JUSTTCG",
    sourcePrice: result.data?.justtcg_price ?? null,
    sourceCurrency: "USD",
    asOf: result.data?.market_price_as_of ?? null,
  });
  const scrydex = await buildProviderPriceDisplay({
    supabase,
    provider: "SCRYDEX",
    sourcePrice: result.data?.scrydex_price ?? result.data?.pokemontcg_price ?? null,
    sourceCurrency: "USD",
    asOf: result.data?.market_price_as_of ?? null,
  });
  const marketPriceUsd = averageProviderUsdPrice([justtcg, scrydex]) ?? result.data?.market_price ?? null;
  const marketPriceAsOf = [justtcg.asOf, scrydex.asOf].filter(Boolean).sort().at(-1) ?? result.data?.market_price_as_of ?? null;

  return NextResponse.json({
    ok: true,
    justtcgPrice: justtcg.usdPrice,
    scrydexPrice: scrydex.usdPrice,
    pokemontcgPrice: scrydex.usdPrice,
    marketPrice: marketPriceUsd,
    marketPriceAsOf,
    providers: [justtcg, scrydex],
    active7d: result.data?.active_listings_7d ?? 0,
    median7d: result.data?.median_7d ?? null,
    median30d: result.data?.median_30d ?? null,
    trimmedMedian30d: result.data?.trimmed_median_30d ?? null,
    low30d: result.data?.low_30d ?? null,
    high30d: result.data?.high_30d ?? null,
  });
}
