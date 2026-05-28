import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  sendApnsToDevice,
  isApnsConfigured,
  APNS_TERMINAL_REASONS,
  type ApnsEnvironment,
} from "@/lib/push/apns";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sends a "your trial ends tomorrow" push at 10:00 LOCAL time on the
 * calendar day before each active subscription expires.
 *
 * Why 10am-local rather than "24h before expiry":
 *   A user who started a trial at 2am UTC (because that's when they
 *   were looking at cards) shouldn't get a push at 2am UTC the day
 *   before — they'd never see it. 10am in their local timezone is the
 *   universally readable hour. Their timezone comes from
 *   apns_device_tokens.timezone (an IANA identifier, e.g.
 *   "America/Los_Angeles") that the iOS client uploads on
 *   registration. Legacy rows without timezone fall back to UTC.
 *
 * Why hourly cron rather than scheduled-per-row:
 *   Vercel crons schedule by cron expression, not per-row deliveries.
 *   Running hourly and gating each candidate row on "is the user's
 *   local hour 10:00–10:59 AND is today the day before expiry?"
 *   produces exactly one delivery per trial, robust against missed
 *   ticks, and lets DST transitions self-correct (the IANA tz handles
 *   the offset shift).
 *
 * Per-row dedupe via apple_subscriptions.trial_expiring_notified_at
 * — once stamped, the row is skipped on every subsequent run for
 * this trial period. A genuinely new trial (different
 * original_transaction_id) gets a fresh shot.
 */
export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  if (!isApnsConfigured()) {
    return NextResponse.json(
      { ok: false, error: "APNs not configured." },
      { status: 500 },
    );
  }

  const supabase = dbAdmin();
  const now = new Date();

  // SQL pre-filter: any active sub expiring within the next 48h that
  // hasn't been notified. The local-time-of-day gate happens in JS
  // because Postgres can't easily do "what hour is it in this user's
  // timezone right now" against a per-row tz column.
  const upper = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const { data: subs, error } = await supabase
    .from("apple_subscriptions")
    .select("original_transaction_id, clerk_user_id, product_id, expires_at")
    .eq("status", "active")
    .is("trial_expiring_notified_at", null)
    .gt("expires_at", now.toISOString())
    .lte("expires_at", upper.toISOString());

  if (error) {
    console.error("[cron/notify-trial-expiring] query failed", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!subs || subs.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, notified: 0 });
  }

  const posthog = getPostHogClient();
  let notified = 0;
  let failed = 0;
  let skippedNoDevice = 0;
  let skippedNotInWindow = 0;

  for (const sub of subs) {
    if (!sub.expires_at) continue;
    const expiresAt = new Date(sub.expires_at);

    // Pull the user's most recently registered enabled device. If they
    // have multiple, the latest one wins as the "primary timezone" —
    // matches the device the user is actively carrying and avoids
    // sending the push at, say, 10am NYC just because their dormant
    // iPad lives there.
    const { data: tokens, error: tokenErr } = await supabase
      .from("apns_device_tokens")
      .select("id, device_token, environment, timezone, last_registered_at")
      .eq("clerk_user_id", sub.clerk_user_id)
      .eq("enabled", true)
      .order("last_registered_at", { ascending: false });

    if (tokenErr) {
      console.warn("[cron/notify-trial-expiring] token query failed", {
        user: sub.clerk_user_id,
        err: tokenErr.message,
      });
      failed++;
      continue;
    }

    if (!tokens || tokens.length === 0) {
      // No active device tokens — user has notifications disabled.
      // Stamp so we don't keep scanning this row; in-app paywall on
      // next launch still covers the conversion path.
      skippedNoDevice++;
      await supabase
        .from("apple_subscriptions")
        .update({ trial_expiring_notified_at: now.toISOString() })
        .eq("original_transaction_id", sub.original_transaction_id);
      continue;
    }

    // Use the most-recent device's timezone as the "user's tz" for
    // scheduling. Falls back to UTC for legacy rows pre-migration.
    const userTimezone = tokens[0].timezone || "UTC";

    if (!isFireWindow(expiresAt, userTimezone, now)) {
      skippedNotInWindow++;
      continue;
    }

    let anyDelivered = false;
    for (const t of tokens) {
      const result = await sendApnsToDevice(
        t.device_token,
        {
          title: "Your free trial ends tomorrow",
          body: "Subscribe to keep your collector profile, market signals, and price alerts.",
        },
        {
          environment: t.environment as ApnsEnvironment,
          threadId: "subscription",
          collapseId: `trial_expiring_${sub.original_transaction_id}`,
          userInfo: {
            type: "trial_expiring",
            original_transaction_id: sub.original_transaction_id,
          },
        },
      );

      if (result.ok) {
        anyDelivered = true;
      } else if (result.reason && APNS_TERMINAL_REASONS.has(result.reason)) {
        // Token is permanently invalid — stop retrying it.
        await supabase
          .from("apns_device_tokens")
          .update({ enabled: false })
          .eq("id", t.id);
      }
    }

    if (anyDelivered) {
      notified++;
      await supabase
        .from("apple_subscriptions")
        .update({ trial_expiring_notified_at: now.toISOString() })
        .eq("original_transaction_id", sub.original_transaction_id);

      // Server-side analytics. Distinct ID matches Clerk userId
      // everywhere else, so funnels join cleanly with the iOS-side
      // paywall_viewed/subscribed events that follow.
      posthog.capture({
        distinctId: sub.clerk_user_id,
        event: "trial_expiring_notified",
        properties: {
          product_id: sub.product_id,
          expires_at: sub.expires_at,
          timezone: userTimezone,
        },
      });
    } else {
      // All sends failed without a terminal reason — leave
      // trial_expiring_notified_at NULL so next hour's run retries.
      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: subs.length,
    notified,
    failed,
    skipped_no_device: skippedNoDevice,
    skipped_not_in_window: skippedNotInWindow,
  });
}

/**
 * True iff `now` falls inside the [10:00, 11:00) hour, in `timezone`,
 * on the calendar day BEFORE `expiresAt`'s local calendar day.
 *
 * Examples (timezone = America/Los_Angeles):
 *   expiresAt = 2026-05-15T18:00:00Z (= 11am PT on the 15th)
 *   → fires when now is between 2026-05-14T17:00:00Z and 18:00:00Z
 *     (= 10:00–11:00 PT on the 14th).
 *
 * The cron schedules at minute 7 of every hour, so it lands cleanly
 * inside the [10:00, 11:00) window once per local day. DST shifts
 * are handled automatically because the formatter uses an IANA tz.
 *
 * Returns false when `timezone` is unparseable (Intl throws), which
 * causes the row to be skipped that run — it'll be retried next hour.
 */
function isFireWindow(expiresAt: Date, timezone: string, now: Date): boolean {
  let nowLocalDate: string;
  let nowLocalHour: number;
  let expiresLocalDate: string;
  try {
    nowLocalDate = formatLocalYMD(now, timezone);
    nowLocalHour = formatLocalHour(now, timezone);
    expiresLocalDate = formatLocalYMD(expiresAt, timezone);
  } catch {
    return false;
  }

  if (nowLocalHour < 10 || nowLocalHour >= 11) return false;

  // Day-difference check using local calendar days. We compare the
  // YMD strings via UTC midnight epoch to avoid month/year rollover
  // bugs around the last-of-month case.
  const nowEpochDay = ymdToUtcMidnight(nowLocalDate);
  const expiresEpochDay = ymdToUtcMidnight(expiresLocalDate);
  const dayDiff = Math.round((expiresEpochDay - nowEpochDay) / (24 * 60 * 60 * 1000));
  return dayDiff === 1;
}

function formatLocalYMD(date: Date, timezone: string): string {
  // en-CA emits the canonical YYYY-MM-DD format that's safe to split.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

function formatLocalHour(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  });
  // hourCycle quirk: some locales emit "24" for midnight. Modulo 24
  // normalizes "24" → 0.
  return Number(formatter.format(date)) % 24;
}

function ymdToUtcMidnight(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
