import { NextResponse } from "next/server";

import { requireCron } from "@/lib/auth/require";
import { getHomepageData } from "@/lib/data/homepage";
import { dbAdmin } from "@/lib/db/admin";

/**
 * Cron: precompute the homepage signal board into public.homepage_cache.
 *
 * /api/homepage runs getHomepageData() — a heavy GLOBAL aggregation (~8s cold,
 * ~211KB) — on every edge-cache miss. The data only changes daily (signal board)
 * / hourly (JP rails), so this cron computes the payload off the hot path and
 * stores it; the public route reads the newest blob via public_homepage_latest
 * (a cheap LIMIT 1) and only falls back to a live getHomepageData() if the blob
 * is missing or stale. Keeps the cold aggregation off the user's critical path.
 *
 * Schedule (vercel.json): hourly at :42 — right after the JP price chain
 * (yahoo :26 → snkrdunk :36 → refresh-jp-price-display :40) and trailing the
 * daily Scrydex chunks + compute-daily-top-movers (21:00 UTC), so the blob
 * captures the freshest data; :42 also dodges the other crons' minutes.
 *
 * Trust: cron — Authorization: Bearer CRON_SECRET.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const PRUNE_BEFORE_DAYS = 2;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startMs = Date.now();
  try {
    const data = await getHomepageData();

    // Empty-blob guard: never overwrite a good cache with an all-empty payload
    // (e.g. a transient DB blip mid-compute). Keep the last good blob + flag the
    // run so it can't silently look healthy. Mirrors the ai-brief degradation
    // predicate (docs/external-api-failure-modes.md).
    const board = data.signal_board;
    const looksEmpty =
      (data.movers?.length ?? 0) === 0 &&
      ((board?.market_watch?.length ?? 0) === 0) &&
      ((board?.breakouts?.length ?? 0) === 0);
    if (looksEmpty) {
      console.error("[cron/refresh-homepage-cache] computed payload looks empty — skipping insert");
      return NextResponse.json(
        { ok: false, error: "empty_payload", durationMs: Date.now() - startMs },
        { status: 500 },
      );
    }

    const supabase = dbAdmin();
    const { error: insertError } = await supabase
      .from("homepage_cache")
      .insert({ payload: data, data_as_of: data.as_of });
    if (insertError) {
      console.error("[cron/refresh-homepage-cache] insert failed:", insertError.message);
      return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
    }

    // Prune old rows. Non-fatal — the public view reads only the newest.
    const pruneCutoff = new Date(
      Date.now() - PRUNE_BEFORE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: pruneError } = await supabase
      .from("homepage_cache")
      .delete()
      .lt("computed_at", pruneCutoff);
    if (pruneError) {
      console.warn("[cron/refresh-homepage-cache] prune failed:", pruneError.message);
    }

    return NextResponse.json({
      ok: true,
      dataAsOf: data.as_of,
      durationMs: Date.now() - startMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/refresh-homepage-cache] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
