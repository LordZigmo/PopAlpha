/**
 * Cron: refresh-derived-signals
 *
 * Calls refresh_derived_signals() to compute PopAlpha branded signals
 * (Trend Strength, Breakout Score, Value Zone) into variant_metrics.
 *
 * Runs nightly at 8am UTC — after sync-justtcg-prices (6am) writes
 * provider_* fields into variant_metrics.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>.
 * ?secret= is a temporary deprecated fallback for manual debugging.
 */

import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { computeVariantSignals } from "@/lib/signals/scoring";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 60;
const SIGNAL_BATCH_SIZE = 150;

type VariantMetricRow = {
  id: string;
  canonical_slug: string;
  variant_ref: string;
  grade: string;
  provider_trend_slope_7d: number | null;
  provider_cov_price_30d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
};

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();

  try {
    const { data, error } = await supabase.rpc("refresh_derived_signals");
    if (error && !error.message.toLowerCase().includes("statement timeout")) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    let rowsUpdated =
      typeof data === "number"
        ? data
        : Number((data as { rowsUpdated?: number; rows?: number } | null)?.rowsUpdated ?? (data as { rows?: number } | null)?.rows ?? 0);

    if (rowsUpdated > 0) {
      return NextResponse.json({ ok: true, rowsUpdated, deprecatedQueryAuth: auth.deprecatedQueryAuth });
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let fallbackRowsUpdated = 0;
    let from = 0;

    while (true) {
      const { data: rows, error: rowsError } = await supabase
        .from("variant_metrics")
        .select([
          "id",
          "canonical_slug",
          "variant_ref",
          "grade",
          "provider_trend_slope_7d",
          "provider_cov_price_30d",
          "provider_price_relative_to_30d_range",
          "provider_price_changes_count_30d",
        ].join(", "))
        .eq("provider", "JUSTTCG")
        .eq("grade", "RAW")
        .order("canonical_slug", { ascending: true })
        .order("variant_ref", { ascending: true })
        .range(from, from + SIGNAL_BATCH_SIZE - 1);

      if (rowsError) {
        return NextResponse.json({ ok: false, error: rowsError.message }, { status: 500 });
      }
      if (!rows || rows.length === 0) break;

      const typedRows = rows as unknown as VariantMetricRow[];
      const rpcKeys = typedRows.map((row) => ({
        canonical_slug: row.canonical_slug,
        variant_ref: row.variant_ref,
        provider: "JUSTTCG",
        grade: row.grade,
      }));
      const { data: batchRpcData, error: batchRpcError } = await supabase.rpc("refresh_derived_signals_for_variants", {
        keys: rpcKeys,
      });
      if (!batchRpcError) {
        fallbackRowsUpdated += Number((batchRpcData as { rowsUpdated?: number } | null)?.rowsUpdated ?? typedRows.length);
        if (typedRows.length < SIGNAL_BATCH_SIZE) break;
        from += SIGNAL_BATCH_SIZE;
        continue;
      }

      const variantRefs = [...new Set(typedRows.map((row) => row.variant_ref))];
      const grades = [...new Set(typedRows.map((row) => row.grade))];
      const { data: priceRows, error: priceError } = await supabase
        .from("variant_price_latest")
        .select("variant_ref, grade, price_value")
        .eq("provider", "JUSTTCG")
        .in("variant_ref", variantRefs)
        .in("grade", grades);

      if (priceError) {
        return NextResponse.json({ ok: false, error: priceError.message }, { status: 500 });
      }

      const latestPriceMap = new Map<string, number | null>();
      for (const priceRow of priceRows ?? []) {
        latestPriceMap.set(
          `${priceRow.variant_ref as string}::${priceRow.grade as string}`,
          priceRow.price_value !== null && priceRow.price_value !== undefined ? Number(priceRow.price_value) : null,
        );
      }

      for (const row of typedRows) {
        const { count, error: countError } = await supabase
          .from("price_history_points")
          .select("ts", { count: "exact", head: true })
          .eq("canonical_slug", row.canonical_slug)
          .eq("variant_ref", row.variant_ref)
          .gte("ts", since);

        if (countError) {
          return NextResponse.json({ ok: false, error: countError.message }, { status: 500 });
        }

        const points30d = count ?? 0;
        const latestPrice = latestPriceMap.get(`${row.variant_ref}::${row.grade}`) ?? null;
        const {
          signal_trend: trend,
          signal_breakout: breakout,
          signal_value: value,
        } = computeVariantSignals({
          trendSlope7d: row.provider_trend_slope_7d,
          covPrice30d: row.provider_cov_price_30d,
          priceRelativeTo30dRange: row.provider_price_relative_to_30d_range,
          priceChangesCount30d: row.provider_price_changes_count_30d,
          latestPrice,
          samplePoints: points30d,
        });
        const hasEnoughHistory = points30d >= 10;

        const { error: updateError } = await supabase
          .from("variant_metrics")
          .update({
            history_points_30d: points30d,
            signal_trend: trend,
            signal_breakout: breakout,
            signal_value: value,
            signals_as_of_ts: hasEnoughHistory ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        if (updateError) {
          return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
        }

        fallbackRowsUpdated += 1;
      }

      if (typedRows.length < SIGNAL_BATCH_SIZE) break;
      from += SIGNAL_BATCH_SIZE;
    }

    rowsUpdated = Math.max(rowsUpdated, fallbackRowsUpdated);
    return NextResponse.json({ ok: true, rowsUpdated, deprecatedQueryAuth: auth.deprecatedQueryAuth });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
