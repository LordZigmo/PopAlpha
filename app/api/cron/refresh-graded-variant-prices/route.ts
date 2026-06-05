/**
 * Cron: refresh-graded-variant-prices
 *
 * Populates graded_variant_prices — the per-(printing, grader, grade) graded price
 * surface (so PSA 10 != CGC 10 != TAG 10). card_metrics has no grader dimension, so its
 * graded "G10" row pools all graders into a meaningless midpoint; this table keeps each
 * grader's own latest price + 14d/7d/30d medians + 30D range + sample count, parsed from
 * variant_price_daily/latest (variant_ref encodes the grader). iOS + the ladder route
 * read public_graded_variant_prices.
 *
 * Why BOUNDED + dedicated (not folded into refresh-set-summaries or -per-printing):
 *   A full ::GRADED:: scan over variant_price_daily times out, and bolting this onto
 *   another cron would share its 300s budget and undo that cron's isolation. So this is
 *   its own lane: refresh_graded_variant_prices drives off variant_metrics (the small
 *   graded-combo source), picks the N stalest cards per tick (maxCards), scopes the price
 *   aggregation by slug, and stamps a watermark so successive ticks rotate through all
 *   ~24k graded cards. Same bounded pattern as refresh-per-printing-display.
 *
 * Schedule: every 2h, maxCards=4000 → ~6 ticks (~12h) for a full cycle over the ~24k
 * graded cards. Sized at 4000 (not 10000): variant_price_daily is ~5M rows, and a larger
 * per-tick scope flips the planner to a full scan that risks the 300s ceiling — and since
 * the watermark only advances on success, a timeout would stick and never make progress
 * (measured post-deploy: 4000 finishes comfortably, 10000 does not). Reads whatever
 * variant_price_daily holds (refreshed daily by refresh-set-summaries at 09:00 UTC).
 *
 * Trust: cron — bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MAX_CARDS = 4000;
const MAX_CARDS_LIMIT = 20000;

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const supabase = dbAdmin();
  const startedAt = Date.now();

  const { data, error } = await supabase.rpc("refresh_graded_variant_prices", {
    p_max_cards: maxCards,
  });
  const elapsedMs = Date.now() - startedAt;

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message, maxCards, elapsedMs },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, result: data, maxCards, elapsedMs });
}
