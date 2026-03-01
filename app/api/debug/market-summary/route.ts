import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { buildRawVariantRef } from "@/lib/identity/variant-ref";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug")?.trim() ?? "";
  const printingId = searchParams.get("printing_id")?.trim() ?? "";

  if (!slug || !printingId) {
    return NextResponse.json(
      { ok: false, error: "Both ?slug= and ?printing_id= are required." },
      { status: 400 },
    );
  }

  const supabase = getServerSupabaseClient();
  const variantRef = buildRawVariantRef(printingId);

  const [{ data: marketLatest }, { data: variantMetrics }, { data: historyRows }] = await Promise.all([
    supabase
      .from("market_latest")
      .select("price_usd, observed_at, updated_at, external_id, currency")
      .eq("canonical_slug", slug)
      .eq("printing_id", printingId)
      .eq("source", "JUSTTCG")
      .eq("grade", "RAW")
      .eq("price_type", "MARKET")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("variant_metrics")
      .select([
        "variant_ref",
        "provider",
        "grade",
        "printing_id",
        "provider_trend_slope_7d",
        "provider_cov_price_30d",
        "provider_price_relative_to_30d_range",
        "provider_price_changes_count_30d",
        "provider_as_of_ts",
        "history_points_30d",
        "updated_at",
      ].join(", "))
      .eq("canonical_slug", slug)
      .eq("printing_id", printingId)
      .eq("provider", "JUSTTCG")
      .eq("grade", "RAW")
      .limit(1)
      .maybeSingle(),
    supabase
      .from("price_history_points")
      .select("ts")
      .eq("canonical_slug", slug)
      .eq("provider", "JUSTTCG")
      .eq("variant_ref", variantRef)
      .eq("source_window", "30d")
      .order("ts", { ascending: true })
      .limit(5000),
  ]);

  const historyCount = historyRows?.length ?? 0;
  const historyMinTs = historyCount > 0 ? historyRows?.[0]?.ts ?? null : null;
  const historyMaxTs = historyCount > 0 ? historyRows?.[historyCount - 1]?.ts ?? null : null;

  return NextResponse.json({
    ok: true,
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
    slug,
    printing_id: printingId,
    variant_ref: variantRef,
    market_latest: {
      exists: Boolean(marketLatest),
      row: marketLatest ?? null,
    },
    price_history_points: {
      count: historyCount,
      min_ts: historyMinTs,
      max_ts: historyMaxTs,
    },
    variant_metrics: {
      exists: Boolean(variantMetrics),
      row: variantMetrics ?? null,
    },
  });
}
