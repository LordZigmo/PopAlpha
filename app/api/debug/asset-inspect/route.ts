import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getDefaultVariantRef } from "@/lib/data/assets";

function auth(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;
  // Also accept ?secret= for browser testing.
  const qs = new URL(req.url).searchParams.get("secret") ?? "";
  return qs === secret;
}

export async function GET(req: Request) {
  if (!auth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");

  if (!slug) {
    return NextResponse.json(
      { error: "?slug= required. Example: ?slug=base-set-charizard" },
      { status: 400 }
    );
  }

  const supabase = getServerSupabaseClient();

  // Parallel: canonical row, latest card_metrics, defaultVariantRef.
  const [{ data: canonical }, { data: metricsRows }, selectedVariantRef] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, set_code, year, card_number, variant")
      .eq("slug", slug)
      .maybeSingle(),
    supabase
      .from("card_metrics")
      .select([
        "grade", "printing_id", "median_7d", "median_30d", "low_30d", "high_30d",
        "trimmed_median_30d", "volatility_30d", "liquidity_score", "percentile_rank",
        "active_listings_7d", "snapshot_count_30d",
        "provider_trend_slope_7d", "provider_cov_price_30d",
        "provider_price_relative_to_30d_range",
        "provider_min_price_all_time", "provider_max_price_all_time",
        "provider_price_changes_count_30d", "provider_as_of_ts",
        "signal_trend_strength", "signal_breakout", "signal_value_zone",
        "signals_as_of_ts", "updated_at",
      ].join(", "))
      .eq("canonical_slug", slug)
      .order("updated_at", { ascending: false })
      .limit(6),
    getDefaultVariantRef(slug),
  ]);

  if (!canonical) {
    return NextResponse.json({ ok: false, error: "No canonical_cards row found for slug" }, { status: 404 });
  }

  // Series point counts by variant_ref (top 5 in last 30d).
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: histRows } = await supabase
    .from("price_history_points")
    .select("variant_ref")
    .eq("canonical_slug", slug)
    .gte("ts", since)
    .limit(2000);

  const countMap = new Map<string, number>();
  for (const r of histRows ?? []) {
    countMap.set(r.variant_ref, (countMap.get(r.variant_ref) ?? 0) + 1);
  }
  const variantCounts = [...countMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([variant_ref, points_30d]) => ({ variant_ref, points_30d }));

  return NextResponse.json({
    ok: true,
    canonical,
    metrics: metricsRows ?? [],
    selectedVariantRef,
    variantCounts,
  });
}
