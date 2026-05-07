import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import type { BlocksListResponse, BlockSummary } from "@/lib/moderation/types";

export const runtime = "nodejs";

/**
 * GET /api/moderation/blocks
 * Returns the authenticated user's outgoing block list, so the iOS
 * client can hide blocked users locally without an extra round-trip
 * per render.
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const db = await createServerSupabaseUserClient();

  const { data, error } = await db
    .from("user_blocks")
    .select("blocked_id, created_at")
    .eq("blocker_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[moderation/blocks GET]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  type Row = { blocked_id: string; created_at: string };
  const rows = (data ?? []) as Row[];
  const blockedIds = rows.map((r) => r.blocked_id);

  const handleMap = new Map<string, string | null>();
  if (blockedIds.length > 0) {
    const { data: users } = await db
      .from("app_users")
      .select("clerk_user_id, handle")
      .in("clerk_user_id", blockedIds);
    for (const u of (users ?? []) as { clerk_user_id: string; handle: string | null }[]) {
      handleMap.set(u.clerk_user_id, u.handle);
    }
  }

  const blocks: BlockSummary[] = rows.map((r) => ({
    blocked_id: r.blocked_id,
    blocked_handle: handleMap.get(r.blocked_id) ?? null,
    created_at: r.created_at,
  }));
  const res: BlocksListResponse = { ok: true, blocks };
  return NextResponse.json(res);
}

/**
 * POST /api/moderation/blocks
 * Body: { blocked_id?: string, blocked_handle?: string }
 * Creates a block. Idempotent (re-blocking is a no-op).
 * Also tears down any follow relationship between the two users.
 *
 * Accepts either blocked_id (preferred — comments and feed items expose
 * actor_id directly) or blocked_handle (used from profile views which
 * navigate by handle). Resolves handle → clerk_user_id via the
 * resolve_profile_handle RPC.
 */
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  let blockedId = typeof body.blocked_id === "string" ? body.blocked_id.trim() : "";
  const blockedHandle = typeof body.blocked_handle === "string" ? body.blocked_handle.trim() : "";

  const db = await createServerSupabaseUserClient();

  if (!blockedId && blockedHandle) {
    const { data } = await db.rpc("resolve_profile_handle", {
      desired_handle_norm: blockedHandle.toLowerCase(),
    });
    blockedId = typeof data === "string" ? data : "";
  }

  if (!blockedId) {
    return NextResponse.json(
      { ok: false, error: "blocked_id or blocked_handle is required." },
      { status: 400 },
    );
  }
  if (blockedId === auth.userId) {
    return NextResponse.json({ ok: false, error: "You can't block yourself." }, { status: 400 });
  }

  const { error: insertErr } = await db
    .from("user_blocks")
    .upsert(
      { blocker_id: auth.userId, blocked_id: blockedId },
      { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true },
    );

  if (insertErr) {
    console.error("[moderation/blocks POST]", insertErr.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  // Tear down any follow relationship in either direction so the block
  // is enforced consistently across feed/profile surfaces.
  await db
    .from("profile_follows")
    .delete()
    .or(
      `and(follower_id.eq.${auth.userId},followee_id.eq.${blockedId}),and(follower_id.eq.${blockedId},followee_id.eq.${auth.userId})`,
    );

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/moderation/blocks?blocked_id=
 * Removes a block. Idempotent.
 */
export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const blockedId = (url.searchParams.get("blocked_id") || "").trim();

  if (!blockedId) {
    return NextResponse.json({ ok: false, error: "blocked_id is required." }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();

  const { error } = await db
    .from("user_blocks")
    .delete()
    .eq("blocker_id", auth.userId)
    .eq("blocked_id", blockedId);

  if (error) {
    console.error("[moderation/blocks DELETE]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
