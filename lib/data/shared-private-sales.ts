/**
 * lib/data/shared-private-sales.ts
 *
 * Read path for the public card-detail chart's "anonymous purchase
 * dots" overlay. Holdings rows where `share_price_publicly = true`
 * have explicitly opted in (via the consent checkbox on the add-
 * holding form). This helper queries those rows, projects only the
 * date + price (no user_id, no cert, no notes), and filters obvious
 * outliers so a typo or weird trade doesn't pollute the chart.
 *
 * Privacy guardrails:
 *   - Service-role read (RLS would block this).
 *   - Project ONLY {date, priceUsd}. Even acquired_on -> date avoids
 *     any time-of-day signal that could correlate with a user.
 *   - Caller is responsible for not echoing user identity anywhere
 *     in the response.
 *
 * Outlier policy: anchor against the dollar median for the same slug
 * computed from chart-window history points, then drop any sale
 * outside [median / OUTLIER_BAND, median * OUTLIER_BAND]. Cuts typos
 * (paid $5 for a $500 card) without throwing away genuine "I got a
 * deal" signal that's still inside one order of magnitude.
 *
 * Data volume: with ~thousands of users and the toggle defaulting
 * off, this query returns at most O(dozens) of rows per slug. Single
 * query, no pagination.
 */
import { createClient } from "@supabase/supabase-js";

export type SharedPrivateSale = {
  date: string;     // ISO date (YYYY-MM-DD), the day the sale happened
  priceUsd: number; // unit price, in USD
};

const OUTLIER_BAND = 5;

function publicSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("shared-private-sales: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getSharedPrivateSalesForSlug(input: {
  canonicalSlug: string;
  marketMedianUsd?: number | null;
  windowDays?: number;
}): Promise<SharedPrivateSale[]> {
  const slug = (input.canonicalSlug ?? "").trim();
  if (!slug) return [];

  const supabase = publicSupabase();
  const since = new Date(Date.now() - (input.windowDays ?? 90) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("holdings")
    .select("price_paid_usd, acquired_on")
    .eq("canonical_slug", slug)
    .eq("share_price_publicly", true)
    .not("price_paid_usd", "is", null)
    .not("acquired_on", "is", null)
    .gte("acquired_on", since)
    .order("acquired_on", { ascending: true })
    .returns<Array<{ price_paid_usd: number | null; acquired_on: string | null }>>();

  if (error) {
    throw new Error(`holdings(shared sales): ${error.message}`);
  }

  const median = Number.isFinite(input.marketMedianUsd) ? Number(input.marketMedianUsd) : null;
  const lowerBound = median !== null && median > 0 ? median / OUTLIER_BAND : 0;
  const upperBound = median !== null && median > 0 ? median * OUTLIER_BAND : Number.POSITIVE_INFINITY;

  const sales: SharedPrivateSale[] = [];
  for (const row of data ?? []) {
    const price = typeof row.price_paid_usd === "number" ? row.price_paid_usd : null;
    const date = typeof row.acquired_on === "string" ? row.acquired_on : null;
    if (price === null || !Number.isFinite(price) || price <= 0) continue;
    if (!date) continue;
    if (price < lowerBound || price > upperBound) continue;
    sales.push({ date, priceUsd: price });
  }
  return sales;
}
