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

// Every pair the ingest keeps fresh (mirror of PAIRS in
// lib/backfill/fx-rates-ingest.ts). JPYUSD was added when the JP price
// pipelines moved off the frozen 0.0068 constant onto the live rate, so
// a stalled JPY series now means stale JP prices — alert on it too.
const MONITORED_PAIRS = ["EURUSD", "JPYUSD"] as const;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const now = new Date();
  const todayIso = toIsoDateUTC(now);
  const weekday = isWeekdayUTC(now);

  const pairs: Array<{
    pair: string;
    stale: boolean;
    reason: string | null;
    latestRateDate: string | null;
    latestRate: number | null;
    latestFetchedAt: string | null;
  }> = [];

  for (const pair of MONITORED_PAIRS) {
    const { data, error } = await supabase
      .from("fx_rates")
      .select("rate_date, rate, fetched_at")
      .eq("source", "ECB_FRANKFURTER")
      .eq("pair", pair)
      .order("rate_date", { ascending: false })
      .limit(1)
      .maybeSingle<FxLatestRow>();

    if (error) {
      return NextResponse.json(
        { ok: false, error: `fx_rates query failed for ${pair}: ${error.message}` },
        { status: 500 },
      );
    }

    if (!data) {
      pairs.push({
        pair,
        stale: true,
        reason: `No fx_rates rows found for ${pair}.`,
        latestRateDate: null,
        latestRate: null,
        latestFetchedAt: null,
      });
      continue;
    }

    const latestRateDate = data.rate_date.slice(0, 10);
    const stale = weekday && latestRateDate < todayIso;
    pairs.push({
      pair,
      stale,
      reason: stale ? `${pair} behind expected ${todayIso} (latest ${latestRateDate}).` : null,
      latestRateDate,
      latestRate: data.rate,
      latestFetchedAt: data.fetched_at,
    });
  }

  const stalePairs = pairs.filter((p) => p.stale).map((p) => p.pair);
  const stale = stalePairs.length > 0;

  const payload = {
    ok: !stale,
    stale,
    stalePairs,
    expectedRateDate: todayIso,
    pairs,
    nowUtc: now.toISOString(),
  };

  return NextResponse.json(payload, { status: stale ? 500 : 200 });
}
