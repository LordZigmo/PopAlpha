import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

type FxLatestRow = {
  rate_date: string;
  rate: number;
  fetched_at: string;
};

function toIsoDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWeekdayUTC(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const now = new Date();
  const todayIso = toIsoDateUTC(now);

  const { data, error } = await supabase
    .from("fx_rates")
    .select("rate_date, rate, fetched_at")
    .eq("source", "ECB_FRANKFURTER")
    .eq("pair", "EURUSD")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle<FxLatestRow>();

  if (error) {
    return NextResponse.json({ ok: false, error: `fx_rates query failed: ${error.message}` }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({
      ok: false,
      stale: true,
      reason: "No fx_rates rows found for EURUSD.",
      expectedRateDate: todayIso,
      latestRateDate: null,
    }, { status: 500 });
  }

  const latestRateDate = data.rate_date.slice(0, 10);
  const stale = isWeekdayUTC(now) && latestRateDate < todayIso;

  const payload = {
    ok: !stale,
    stale,
    expectedRateDate: todayIso,
    latestRateDate,
    latestRate: data.rate,
    latestFetchedAt: data.fetched_at,
    nowUtc: now.toISOString(),
  };

  return NextResponse.json(payload, { status: stale ? 500 : 200 });
}
