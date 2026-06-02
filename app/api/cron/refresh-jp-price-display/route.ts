/**
 * Cron: refresh-jp-price-display
 *
 * Recomputes the JP-native display price on JP card_metrics rows:
 * jp_latest_price (freshest trusted sold observation) + jp_display_price
 * (14-day median), blended across Snkrdunk + Yahoo! JP. These power the iOS JP
 * detail's "freshest hero + 14-day median sub-line" UX. Dedicated jp_* columns,
 * never the Scrydex-semantics latest_price / display_price (see the migration
 * 20260602040000 header for the full design + trust-floor rationale).
 *
 * Why UNBOUNDED (unlike refresh-per-printing-display): JP reads the small
 * jp_card_price_history (~34k rows), so a full ~90k-row pass measures ~0.8s with
 * the diff predicate (write only rows whose jp_* changed). No watermark/index
 * pacing needed. Runs hourly, just after the JP source crons (Yahoo :26,
 * Snkrdunk :36), so a new sold listing surfaces within the hour; most hours the
 * diff predicate writes nothing.
 *
 * Optional `maxCards` query param is a defensive manual bound (absent = all).
 *
 * Trust: cron — bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_CARDS_LIMIT = 100000;

// Absent / invalid → null (unbounded: refresh all JP rows). A positive value
// caps the batch (manual use only).
function parseMaxCards(raw: string | null): number | null {
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const supabase = dbAdmin();
  const startedAt = Date.now();

  const { data, error } = await supabase.rpc("refresh_jp_price_display", {
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
