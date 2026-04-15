/**
 * Cron: downsample-price-history
 *
 * Cleans up intra-day duplicate rows in price_history_points for data
 * older than 30 days, keeping 1 point per (card, variant, provider,
 * source_window) per day.
 *
 * During initial backlog cleanup, this runs daily at 4:15 AM and
 * processes ~7 days of historical data per invocation. Once the
 * backlog is clear (totalDeleted = 0), remove the cron entry —
 * ongoing downsampling is handled by prune_old_data() step 7b.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEADLINE_RESERVE_MS = 30_000;

function parseOptionalInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const deadline = startedAt + (maxDuration * 1000) - DEADLINE_RESERVE_MS;

  const url = new URL(req.url);
  const maxDaysPerRun = Math.max(1, Math.min(parseOptionalInt(url.searchParams.get("days"), 7), 30));
  const batchSize = Math.max(1000, Math.min(parseOptionalInt(url.searchParams.get("batch"), 10000), 50000));

  const supabase = dbAdmin();
  const days: Array<{ date: string; deleted: number }> = [];
  let totalDeleted = 0;
  let firstError: string | null = null;

  try {
    // Find the oldest date that needs downsampling (older than 30 days)
    const { data: oldestRow, error: oldestError } = await supabase
      .from("price_history_points")
      .select("ts")
      .lt("ts", new Date(Date.now() - 30 * 86400000).toISOString())
      .order("ts", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (oldestError) throw new Error(`find oldest: ${oldestError.message}`);
    if (!oldestRow) {
      return NextResponse.json({
        ok: true,
        job: "downsample_price_history",
        message: "No data older than 30 days needs downsampling",
        totalDeleted: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // Start from the oldest date and work forward
    const oldestDate = new Date(oldestRow.ts);
    oldestDate.setUTCHours(0, 0, 0, 0);

    for (let dayIndex = 0; dayIndex < maxDaysPerRun; dayIndex++) {
      if (Date.now() >= deadline) break;

      const dayStart = new Date(oldestDate.getTime() + dayIndex * 86400000);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const cutoff = new Date(Date.now() - 30 * 86400000);

      // Stop if we've reached the 30-day boundary
      if (dayStart >= cutoff) break;

      let dayDeleted = 0;

      // Inner loop: batch within a single day
      for (let batch = 0; batch < 20; batch++) {
        if (Date.now() >= deadline) break;

        const { data, error } = await supabase.rpc(
          "downsample_price_history_points_batch",
          {
            p_batch_size: batchSize,
            p_older_than: dayEnd.toISOString(),
            p_newer_than: dayStart.toISOString(),
          },
        );

        if (error) throw new Error(`downsample day ${dayStart.toISOString().slice(0, 10)}: ${error.message}`);
        const deleted = (data as { deleted: number })?.deleted ?? 0;
        dayDeleted += deleted;
        if (deleted < batchSize) break; // day is fully downsampled
      }

      days.push({ date: dayStart.toISOString().slice(0, 10), deleted: dayDeleted });
      totalDeleted += dayDeleted;
    }
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  const ok = firstError === null;
  return NextResponse.json(
    {
      ok,
      job: "downsample_price_history",
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      totalDeleted,
      daysProcessed: days.length,
      firstError,
      days,
    },
    { status: ok ? 200 : 500 },
  );
}
