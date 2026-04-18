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
  // Hard outer try/catch so NOTHING can escape as an unhandled
  // exception (Vercel returns empty-body 500s in that case, which is
  // useless for diagnosis). Stage tracking tells us exactly which step
  // blew up; we surface it in the response body so iOS sees something
  // actionable instead of a blank wall.
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

    stage = "create-db-client";
    const db = await createServerSupabaseUserClient();
    const now = new Date().toISOString();

    // Explicit delete-then-insert instead of upsert with onConflict.
    // PostgREST's onConflict matcher has been finicky with the
    // (clerk_user_id, device_token) composite unique index in this
    // project — the constraint exists and works at the SQL level but
    // PostgREST returns "no unique or exclusion constraint matching
    // the ON CONFLICT specification". Explicit two-step is bulletproof,
    // RLS-safe (both ops are scoped by clerk_user_id), and the only
    // race is two registrations for the same device in the same
    // millisecond — in which case the second wins, which is what
    // we'd want anyway since the row content is identical.
    stage = "db-delete";
    const { error: deleteError } = await db
      .from("apns_device_tokens")
      .delete()
      .eq("clerk_user_id", auth.userId)
      .eq("device_token", deviceToken);
    if (deleteError) throw new Error(`delete: ${deleteError.message}`);

    stage = "db-insert";
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
    // Wrap-all catch — nothing should make it past this. Includes the
    // failing stage so iOS / curl can see what actually went wrong.
    console.error(`[device/register] stage=${stage}`, error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, stage, error: message },
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
