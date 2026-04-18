import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

// Native iOS device token registration for APNs push.
// Called by PushService on iOS after the OS hands us a device token
// (see ios/PopAlphaApp/PushService.swift).
//
// Uses dbAdmin() because the iOS app sends a Clerk Bearer JWT that
// Supabase RLS cannot validate (no JWT template configured). Since
// requireUser() already verifies identity and every query filters by
// clerk_user_id = auth.userId, this is equivalent in security to RLS.
// Same pattern as /api/holdings/route.ts.

export const runtime = "nodejs";

// Device tokens are 64-byte hex (128 chars). We accept a tolerant range
// in case Apple ever lengthens them.
const HEX_TOKEN_REGEX = /^[a-f0-9]{40,256}$/i;

function sanitizeTrim(input: unknown, maxLength: number): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().slice(0, maxLength);
  return trimmed || null;
}

export async function POST(req: Request) {
  let stage = "init";
  try {
    stage = "auth";
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    stage = "parse-body";
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
    }

    stage = "validate";
    const deviceToken = sanitizeTrim(body.device_token, 256);
    const bundleId = sanitizeTrim(body.bundle_id, 128);
    const environmentRaw = sanitizeTrim(body.environment, 32);
    const deviceModel = sanitizeTrim(body.device_model, 128);
    const osVersion = sanitizeTrim(body.os_version, 64);

    if (!deviceToken || !HEX_TOKEN_REGEX.test(deviceToken)) {
      return NextResponse.json(
        { ok: false, error: "Invalid device_token." },
        { status: 400 },
      );
    }
    if (!bundleId) {
      return NextResponse.json(
        { ok: false, error: "bundle_id is required." },
        { status: 400 },
      );
    }
    if (environmentRaw !== "development" && environmentRaw !== "production") {
      return NextResponse.json(
        { ok: false, error: 'environment must be "development" or "production".' },
        { status: 400 },
      );
    }

    stage = "db-write";
    const db = dbAdmin();
    const now = new Date().toISOString();

    // Delete-then-insert keyed by (clerk_user_id, device_token) so token
    // rotation / reinstall is handled cleanly without leaving stale rows.
    // Both ops manually filter by auth.userId; the admin client has no
    // RLS but the userId came from requireUser()'s Clerk verification,
    // so cross-user writes are impossible by construction.
    const { error: deleteError } = await db
      .from("apns_device_tokens")
      .delete()
      .eq("clerk_user_id", auth.userId)
      .eq("device_token", deviceToken);
    if (deleteError) throw new Error(`delete: ${deleteError.message}`);

    const { error: insertError } = await db.from("apns_device_tokens").insert({
      clerk_user_id: auth.userId,
      device_token: deviceToken,
      bundle_id: bundleId,
      environment: environmentRaw,
      device_model: deviceModel,
      os_version: osVersion,
      enabled: true,
      updated_at: now,
      last_registered_at: now,
    });
    if (insertError) throw new Error(`insert: ${insertError.message}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[device/register] stage=${stage}`, error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, stage, error: message }, { status: 500 });
  }
}

/**
 * Unregister a device. Hook is exposed for future use (sign-out, user
 * disabling notifications in iOS Settings, etc).
 */
export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const deviceToken = sanitizeTrim(body.device_token, 256);
  if (!deviceToken) {
    return NextResponse.json(
      { ok: false, error: "device_token is required." },
      { status: 400 },
    );
  }

  try {
    const db = dbAdmin();
    const { error } = await db
      .from("apns_device_tokens")
      .delete()
      .eq("clerk_user_id", auth.userId)
      .eq("device_token", deviceToken);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[device/register DELETE]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
