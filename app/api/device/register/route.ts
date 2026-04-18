import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";

// Native iOS device token registration for APNs push.
// Called by PushService on iOS after the OS hands us a device token
// (see ios/PopAlphaApp/PushService.swift). Upsert-keyed on
// (clerk_user_id, device_token) so token rotation / reinstall is
// handled transparently without creating duplicate rows.

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
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

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

  try {
    const db = await createServerSupabaseUserClient();
    const now = new Date().toISOString();
    const { error } = await db.from("apns_device_tokens").upsert(
      {
        clerk_user_id: auth.userId,
        device_token: deviceToken,
        bundle_id: bundleId,
        environment: environmentRaw,
        device_model: deviceModel,
        os_version: osVersion,
        enabled: true,
        updated_at: now,
        last_registered_at: now,
      },
      { onConflict: "clerk_user_id,device_token" },
    );

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * Unregister a device. Called on sign-out or when the user disables
 * notifications in iOS Settings — though today iOS side doesn't wire
 * this up (it just clears the local upload cache). Endpoint exists so
 * the hook is available when we need it.
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
    const db = await createServerSupabaseUserClient();
    const { error } = await db
      .from("apns_device_tokens")
      .delete()
      .eq("clerk_user_id", auth.userId)
      .eq("device_token", deviceToken);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
