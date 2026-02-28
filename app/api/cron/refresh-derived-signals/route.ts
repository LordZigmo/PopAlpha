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
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 60;

type VariantMetricRow = {
  id: string;
  canonical_slug: string;
  variant_ref: string;
  provider_trend_slope_7d: number | null;
  provider_cov_price_30d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
};

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();

  try {
    const { data, error } = await supabase.rpc("refresh_derived_signals");
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    let rowsUpdated =
      typeof data === "number"
        ? data
        : Number((data as { rowsUpdated?: number; rows?: number } | null)?.rowsUpdated ?? (data as { rows?: number } | null)?.rows ?? 0);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let fallbackRowsUpdated = 0;
    let from = 0;
    const pageSize = 250;

    while (true) {
      const { data: rows, error: rowsError } = await supabase
        .from("variant_metrics")
        .select([
          "id",
          "canonical_slug",
          "variant_ref",
          "provider_trend_slope_7d",
          "provider_cov_price_30d",
          "provider_price_relative_to_30d_range",
          "provider_price_changes_count_30d",
        ].join(", "))
        .eq("provider", "JUSTTCG")
        .eq("grade", "RAW")
        .range(from, from + pageSize - 1);

      if (rowsError) {
        return NextResponse.json({ ok: false, error: rowsError.message }, { status: 500 });
      }
      if (!rows || rows.length === 0) break;

      const typedRows = rows as unknown as VariantMetricRow[];

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
        const hasEnoughHistory = points30d >= 10;
        const trend =
          hasEnoughHistory
          && row.provider_trend_slope_7d !== null
          && row.provider_cov_price_30d !== null
          && row.provider_cov_price_30d !== 0
            ? roundTo(row.provider_trend_slope_7d / row.provider_cov_price_30d, 4)
            : null;
        const breakout =
          hasEnoughHistory
          && row.provider_trend_slope_7d !== null
          && row.provider_price_relative_to_30d_range !== null
            ? roundTo(
                row.provider_trend_slope_7d
                  * Math.log(1 + Math.max(row.provider_price_changes_count_30d ?? 0, 0))
                  * (1 - row.provider_price_relative_to_30d_range),
                4,
              )
            : null;
        const value =
          hasEnoughHistory && row.provider_price_relative_to_30d_range !== null
            ? roundTo((1 - row.provider_price_relative_to_30d_range) * 100, 2)
            : null;

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

      if (typedRows.length < pageSize) break;
      from += pageSize;
    }

    rowsUpdated = Math.max(rowsUpdated, fallbackRowsUpdated);
    return NextResponse.json({ ok: true, rowsUpdated, deprecatedQueryAuth: auth.deprecatedQueryAuth });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
