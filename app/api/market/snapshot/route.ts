import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type SnapshotRow = {
  card_variant_id: string;
  active_listing_count: number | null;
  median_price_7d: number | null;
  median_price_30d: number | null;
  trimmed_median_30d: number | null;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cardVariantId = url.searchParams.get("cardVariantId")?.trim() ?? "";
  if (!cardVariantId) {
    return NextResponse.json({ ok: false, error: "Missing cardVariantId query param." }, { status: 400 });
  }

  const supabase = getServerSupabaseClient();
  const { data, error } = await supabase
    .from("market_snapshot")
    .select("card_variant_id, active_listing_count, median_price_7d, median_price_30d, trimmed_median_30d")
    .eq("card_variant_id", cardVariantId)
    .maybeSingle<SnapshotRow>();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    activeListings: data?.active_listing_count ?? 0,
    median7d: data?.median_price_7d ?? null,
    median30d: data?.median_price_30d ?? null,
    trimmedMedian30d: data?.trimmed_median_30d ?? null,
  });
}

