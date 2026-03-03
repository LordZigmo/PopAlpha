import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { refreshSetSummaryPipeline } from "@/lib/sets/refresh";
import { buildSetId } from "@/lib/sets/summary-core.mjs";
import { dbAdmin } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

function computeLookbackDays(asOfDate: string | undefined): number {
  if (!asOfDate) return 35;
  const target = new Date(`${asOfDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(target)) return 35;
  const current = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  const dayDelta = Math.max(0, Math.round((current - target) / (24 * 60 * 60 * 1000)));
  return Math.max(35, Math.min(dayDelta + 35, 365));
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const asOfDate = url.searchParams.get("asOfDate")?.trim() || undefined;
  const setName = url.searchParams.get("setName")?.trim() || "";
  const setId = url.searchParams.get("setId")?.trim() || buildSetId(setName);
  const supabase = dbAdmin();
  const lookbackDays = computeLookbackDays(asOfDate);

  try {
    if (setId) {
      const { error: latestError } = await supabase.rpc("refresh_variant_price_latest");
      if (latestError) {
        return NextResponse.json({ ok: false, error: latestError.message }, { status: 500 });
      }

      const { error: dailyError } = await supabase.rpc("refresh_variant_price_daily", {
        lookback_days: lookbackDays,
      });
      if (dailyError) {
        return NextResponse.json({ ok: false, error: dailyError.message }, { status: 500 });
      }

      const { error: signalsError } = await supabase.rpc("refresh_variant_signals_latest");
      if (signalsError) {
        return NextResponse.json({ ok: false, error: signalsError.message }, { status: 500 });
      }

      const targetDate = asOfDate ?? new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase.rpc("refresh_set_summary_snapshots", {
        target_as_of_date: targetDate,
        only_set_ids: [setId],
      });

      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }

      const { data: finishData, error: finishError } = await supabase.rpc("refresh_set_finish_summary_latest", {
        only_set_ids: [setId],
      });

      if (finishError) {
        return NextResponse.json({ ok: false, error: finishError.message }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        mode: "targeted",
        setId,
        asOfDate: targetDate,
        lookbackDays,
        snapshotRows: data,
        finishRows: finishData,
              });
    }

    const result = await refreshSetSummaryPipeline({
      supabase,
      asOfDate,
      lookbackDays,
    });

    if (result.error) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      mode: result.mode,
      result: result.result,
          });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
