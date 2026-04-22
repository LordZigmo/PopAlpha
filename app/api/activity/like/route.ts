import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import { emitNotification } from "@/lib/activity/emit";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";

/**
 * POST /api/activity/like — toggle like on an activity event
 * Body: { event_id: number }
 * Returns: { ok: true, liked: boolean, like_count: number }
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
  if (!eventId) {
    return NextResponse.json({ ok: false, error: "event_id is required." }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();

  // Check if already liked
  const { data: existing } = await db
    .from("activity_likes")
    .select("event_id")
    .eq("event_id", eventId)
    .eq("user_id", auth.userId)
    .maybeSingle();

  let liked: boolean;

  if (existing) {
    // Unlike
    await db
      .from("activity_likes")
      .delete()
      .eq("event_id", eventId)
      .eq("user_id", auth.userId);
    liked = false;
  } else {
    // Like
    const { error } = await db.from("activity_likes").insert({
      event_id: eventId,
      user_id: auth.userId,
    });
    if (error) {
      console.error("[activity/like]", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    liked = true;

    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: auth.userId,
      event: "activity_liked",
      properties: { event_id: eventId },
    });

    // Notify event actor (async, don't block)
    const { data: event } = await db
      .from("activity_events")
      .select("actor_id")
      .eq("id", eventId)
      .maybeSingle();

    if (event?.actor_id) {
      emitNotification({
        recipientId: event.actor_id,
        actorId: auth.userId,
        type: "like",
        eventId,
      });
    }
  }

  // Get updated count
  const { data: likes } = await db
    .from("activity_likes")
    .select("event_id")
    .eq("event_id", eventId);

  return NextResponse.json({
    ok: true,
    liked,
    like_count: likes?.length ?? 0,
  });
}
