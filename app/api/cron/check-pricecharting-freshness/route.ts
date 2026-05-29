/**
 * Cron: check-pricecharting-freshness
 *
 * Health check for the trustworthy-price feed. The `import-pricecharting`
 * cron refreshes `canonical_trusted_raw_prices` daily at 11:00 UTC; this runs
 * a few hours later (14:00 UTC) and FAILS LOUD — HTTP 500, which Vercel
 * surfaces as a failed cron invocation (its built-in alert path) — if the
 * trusted-price rails haven't been refreshed in > MAX_TRUSTED_PRICE_AGE_HOURS.
 *
 * Why this exists: the `public_card_metrics` view fails CLOSED on stale data,
 * so if the feed silently stops (expired `PRICECHARTING_CSV_URL`, a cron
 * error, a CSV-format change), the priced-card count quietly collapses back
 * toward ~139 with no error anywhere. That exact failure already happened once
 * (the manual feed stopped for days unnoticed). A stale `updated_at` is the
 * single signal that catches the whole chain: a failed import never reaches
 * the parity RPC, so it never bumps `updated_at`.
 *
 * Mirrors `check-fx-rates-health`: one tiny query, 500-on-stale. To receive
 * the alert, keep Vercel's cron-failure notifications enabled (or watch the
 * cron dashboard).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

// 26h: the import runs every 24h at 11:00 UTC and this check runs at 14:00 UTC,
// so a healthy refresh is ~3h old here while a single missed daily run is ~27h
// old — comfortably distinguished, with margin against Vercel cron jitter.
const MAX_TRUSTED_PRICE_AGE_HOURS = 26;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const now = new Date();

  const { data, error } = await supabase
    .from("canonical_trusted_raw_prices")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ updated_at: string }>();

  if (error) {
    const payload = { ok: false, error: `canonical_trusted_raw_prices query failed: ${error.message}` };
    console.error("[check-pricecharting-freshness] summary", JSON.stringify(payload));
    return NextResponse.json(payload, { status: 500 });
  }

  if (!data?.updated_at) {
    const payload = {
      ok: false,
      stale: true,
      reason: "canonical_trusted_raw_prices is empty — the PriceCharting feed has never run.",
      lastRefreshAt: null,
      nowUtc: now.toISOString(),
    };
    console.error("[check-pricecharting-freshness] summary", JSON.stringify(payload));
    return NextResponse.json(payload, { status: 500 });
  }

  const lastRefreshAt = new Date(data.updated_at);
  const ageHours = (now.getTime() - lastRefreshAt.getTime()) / 3_600_000;
  const stale = ageHours > MAX_TRUSTED_PRICE_AGE_HOURS;

  const payload = {
    ok: !stale,
    stale,
    reason: stale
      ? `Trusted prices last refreshed ${ageHours.toFixed(1)}h ago (> ${MAX_TRUSTED_PRICE_AGE_HOURS}h) — import-pricecharting may have stopped. Check PRICECHARTING_CSV_URL and the cron's Vercel logs.`
      : null,
    lastRefreshAt: lastRefreshAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    maxAgeHours: MAX_TRUSTED_PRICE_AGE_HOURS,
    nowUtc: now.toISOString(),
  };

  console[stale ? "error" : "info"]("[check-pricecharting-freshness] summary", JSON.stringify(payload));
  return NextResponse.json(payload, { status: stale ? 500 : 200 });
}
