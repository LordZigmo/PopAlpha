import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  APNS_TERMINAL_REASONS,
  isApnsConfigured,
  sendApnsToDevice,
  type ApnsEnvironment,
} from "@/lib/push/apns";

// Fires a test APNs push to every device registered by the authed user.
// Zero triggers wired today — this is the only path that sends a real
// push on iOS. Useful for:
//   • confirming the .p8 / Team ID / Key ID are set correctly
//   • smoke-testing entitlement + provisioning on a new device
//   • dogfooding notification copy from an internal admin view
//
// Returns per-device results so the caller can see which tokens fail
// and why — Apple's reason codes are passed through verbatim. Terminal
// reasons (BadDeviceToken, Unregistered, etc) flip `enabled = false`
// on the offending row so we never retry them.

export const runtime = "nodejs";

interface PerDeviceResult {
  device_token_suffix: string;
  environment: ApnsEnvironment;
  ok: boolean;
  status_code: number;
  reason?: string;
  apns_id?: string;
  disabled?: boolean;
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  if (!isApnsConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "APNs is not configured. Set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, APNS_BUNDLE_ID.",
      },
      { status: 503 },
    );
  }

  // Accept optional custom title/body so a developer can preview copy.
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — defaults below.
  }

  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim().slice(0, 100)
    : "PopAlpha";
  const messageBody = typeof body.body === "string" && body.body.trim()
    ? body.body.trim().slice(0, 240)
    : "Push notifications are working — you're all set.";

  try {
    // Same dbAdmin() rationale as /api/device/register — Supabase RLS
    // can't validate Clerk Bearer JWTs from iOS; the requireUser() check
    // above plus the explicit eq("clerk_user_id", auth.userId) filter
    // give equivalent isolation.
    const db = dbAdmin();

    const { data: rows, error } = await db
      .from("apns_device_tokens")
      .select("id, device_token, environment")
      .eq("clerk_user_id", auth.userId)
      .eq("enabled", true);

    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No registered iOS devices. Open the iOS app, grant notification permission, and try again.",
        },
        { status: 404 },
      );
    }

    // Fan out serially — we're talking to at most a handful of devices
    // per user and APNs rate-limits per-connection. Simpler than
    // parallelizing and avoids HOL blocking surprises.
    const results: PerDeviceResult[] = [];
    for (const row of rows) {
      const res = await sendApnsToDevice(
        row.device_token,
        { title, body: messageBody },
        {
          environment: row.environment as ApnsEnvironment,
          sound: "default",
          threadId: "popalpha.test",
          userInfo: { source: "test-push" },
        },
      );

      const suffix = row.device_token.slice(-8);
      let disabled = false;

      // Terminal reasons → stop sending to this row. Log and move on.
      if (!res.ok && res.reason && APNS_TERMINAL_REASONS.has(res.reason)) {
        const { error: disableError } = await db
          .from("apns_device_tokens")
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (!disableError) disabled = true;
      }

      results.push({
        device_token_suffix: suffix,
        environment: row.environment as ApnsEnvironment,
        ok: res.ok,
        status_code: res.statusCode,
        reason: res.reason,
        apns_id: res.apnsId,
        disabled,
      });
    }

    const anyOk = results.some((r) => r.ok);
    return NextResponse.json({
      ok: anyOk,
      delivered: results.filter((r) => r.ok).length,
      attempted: results.length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
