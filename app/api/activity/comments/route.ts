import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import { emitNotification } from "@/lib/activity/emit";
import type { ActivityComment } from "@/lib/activity/types";
import { fetchActorProfiles } from "@/lib/activity/actors";
import { getBlockedUserIds } from "@/lib/moderation/blocked-users";
import { validateUserContent } from "@/lib/moderation/keyword-blocklist";

export const runtime = "nodejs";

/**
 * GET /api/activity/comments?event_id=&limit=
 * Fetch comments for an activity event.
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const eventId = Number(url.searchParams.get("event_id") || "0") || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") || "50") || 50, 100);

  if (!eventId) {
    return NextResponse.json({ ok: false, error: "event_id is required." }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();
  const blockedIds = await getBlockedUserIds(db, auth.userId);

  let query = db
    .from("activity_comments")
    .select("id, author_id, body, created_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (blockedIds.length > 0) {
    query = query.not("author_id", "in", `(${blockedIds.map((id) => `"${id}"`).join(",")})`);
  }

  const { data: rows, error } = await query;

  if (error) {
    console.error("[activity/comments GET]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const authorIds = [...new Set((rows ?? []).map((r: { author_id: string }) => r.author_id))];
  const authorMap = await fetchActorProfiles(db, authorIds);

  const comments: ActivityComment[] = (rows ?? []).map((r: { id: number; author_id: string; body: string; created_at: string }) => ({
    id: r.id,
    author: {
      id: r.author_id,
      handle: authorMap.get(r.author_id)?.handle ?? "collector",
      avatar_url: authorMap.get(r.author_id)?.avatarUrl ?? null,
    },
    body: r.body,
    created_at: r.created_at,
  }));

  return NextResponse.json({ ok: true, comments });
}

/**
 * POST /api/activity/comments — add a comment
 * Body: { event_id: number, body: string }
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

  const eventId = typeof body.event_id === "number" ? body.event_id : 0;
  const text = typeof body.body === "string" ? body.body.trim() : "";

  if (!eventId) {
    return NextResponse.json({ ok: false, error: "event_id is required." }, { status: 400 });
  }
  if (!text || text.length > 500) {
    return NextResponse.json({ ok: false, error: "body must be 1-500 characters." }, { status: 400 });
  }

  const filterCheck = validateUserContent(text);
  if (!filterCheck.ok) {
    return NextResponse.json({ ok: false, error: filterCheck.reason }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();

  // Refuse to comment on an event whose author has blocked the requester
  // (or vice-versa). Returning 404-shaped error avoids confirming the block.
  const { data: eventOwner } = await db
    .from("activity_events")
    .select("actor_id")
    .eq("id", eventId)
    .maybeSingle();

  if (eventOwner?.actor_id && eventOwner.actor_id !== auth.userId) {
    const { data: blockRow } = await db
      .from("user_blocks")
      .select("blocker_id")
      .or(
        `and(blocker_id.eq.${auth.userId},blocked_id.eq.${eventOwner.actor_id}),and(blocker_id.eq.${eventOwner.actor_id},blocked_id.eq.${auth.userId})`,
      )
      .limit(1);
    if ((blockRow?.length ?? 0) > 0) {
      return NextResponse.json(
        { ok: false, error: "This event is no longer available." },
        { status: 404 },
      );
    }
  }

  const { data: comment, error } = await db
    .from("activity_comments")
    .insert({
      event_id: eventId,
      author_id: auth.userId,
      body: text,
    })
    .select("id, created_at")
    .single();

  if (error) {
    console.error("[activity/comments POST]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  // Notify event actor
  const { data: event } = await db
    .from("activity_events")
    .select("actor_id")
    .eq("id", eventId)
    .maybeSingle();

  if (event?.actor_id) {
    emitNotification({
      recipientId: event.actor_id,
      actorId: auth.userId,
      type: "comment",
      eventId,
    });
  }

  return NextResponse.json({ ok: true, id: comment.id, created_at: comment.created_at });
}
