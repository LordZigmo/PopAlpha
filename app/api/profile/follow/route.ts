import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import { ensureAppUser } from "@/lib/data/app-user";

export const runtime = "nodejs";

async function resolveHandle(handle: string): Promise<string | null> {
  const db = await createServerSupabaseUserClient();
  const { data, error } = await db.rpc("resolve_profile_handle", {
    desired_handle_norm: handle.trim().toLowerCase(),
  });

  if (error) throw new Error(error.message);
  return typeof data === "string" && data ? data : null;
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

  const handle = typeof body.handle === "string" ? body.handle : "";
  if (!handle.trim()) {
    return NextResponse.json({ ok: false, error: "Missing handle." }, { status: 400 });
  }

  try {
    await ensureAppUser(auth.userId);
    const followeeId = await resolveHandle(handle);
    if (!followeeId) {
      return NextResponse.json({ ok: false, error: "Profile not found." }, { status: 404 });
    }

    const db = await createServerSupabaseUserClient();
    const { error } = await db.from("profile_follows").upsert(
      {
        follower_id: auth.userId,
        followee_id: followeeId,
      },
      { onConflict: "follower_id,followee_id" },
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

export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const handle = new URL(req.url).searchParams.get("handle") ?? "";
  if (!handle.trim()) {
    return NextResponse.json({ ok: false, error: "Missing handle." }, { status: 400 });
  }

  try {
    const followeeId = await resolveHandle(handle);
    if (!followeeId) {
      return NextResponse.json({ ok: false, error: "Profile not found." }, { status: 404 });
    }

    const db = await createServerSupabaseUserClient();
    const { error } = await db
      .from("profile_follows")
      .delete()
      .eq("follower_id", auth.userId)
      .eq("followee_id", followeeId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
