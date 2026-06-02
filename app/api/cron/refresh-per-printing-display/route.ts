/**
 * Cron: refresh-per-printing-display
 *
 * Keeps the PER-FINISH price fields fresh on per-printing card_metrics rows:
 * latest_price (freshest daily snapshot point) + display_price (3-day median) +
 * the median-basis change. These power the iOS detail's "hero follows the finish"
 * UX, where tapping a finish shows that finish's own freshest price + median.
 *
 * Why a dedicated, BOUNDED cron (not folded into refresh_price_changes):
 *   Doing all ~49k per-printing rows in one pass measured at ~255s (~5ms/row;
 *   card_metrics is wide+indexed) — too close to the function ceiling, and it
 *   caused a 45-min runaway when bundled with the canonical refresh (see
 *   20260602020000). So this calls refresh_per_printing_raw_price_display(maxCards),
 *   which processes the N STALEST rows per tick (per_printing_display_refreshed_at
 *   watermark) and rotates through the whole set over a few ticks. Each tick is
 *   bounded (~5k rows ≈ 27s) and can never run away. Same pattern as
 *   refresh-card-translations.
 *
 * Schedule: every 2h, maxCards=10000 → ~5 ticks (~10h) for a full cycle; the
 * first run after deploy drains the initial backfill over the first cycle.
 *
 * Trust: cron — bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MAX_CARDS = 10000;
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

  const { data, error } = await supabase.rpc("refresh_per_printing_raw_price_display", {
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
