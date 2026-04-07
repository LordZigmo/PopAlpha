import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import type { ActivityFeedItem, CardFriendActivity } from "@/lib/activity/types";

export const runtime = "nodejs";

/**
 * GET /api/activity/card?slug=
 * Friend activity related to a specific card.
 * Returns: owner count among followed users + recent activity items.
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") ?? "";

  if (!slug) {
    return NextResponse.json({ ok: false, error: "slug is required." }, { status: 400 });
  }

  const db = await createServerSupabaseUserClient();

  // Get followed user IDs
  const { data: followRows } = await db
    .from("profile_follows")
    .select("followee_id")
    .eq("follower_id", auth.userId);

  const followedIds = (followRows ?? []).map((r: { followee_id: string }) => r.followee_id);

  if (followedIds.length === 0) {
    const res: CardFriendActivity = { ok: true, owner_count: 0, recent: [] };
    return NextResponse.json(res);
  }

  // Count followed users who own this card (via activity events)
  const { data: ownerEvents } = await db
    .from("activity_events")
    .select("actor_id")
    .eq("canonical_slug", slug)
    .eq("event_type", "collection.card_added")
    .in("actor_id", followedIds);

  const uniqueOwners = new Set((ownerEvents ?? []).map((r: { actor_id: string }) => r.actor_id));

  // Recent activity from followed users for this card
  const { data: recentEvents } = await db
    .from("activity_events")
    .select("id, actor_id, event_type, canonical_slug, metadata, created_at")
    .eq("canonical_slug", slug)
    .in("actor_id", followedIds)
    .order("created_at", { ascending: false })
    .limit(3);

  const rows = recentEvents ?? [];

  // Hydrate actor handles
  const actorIds = [...new Set(rows.map((r: { actor_id: string }) => r.actor_id))];
  const { data: actors } = actorIds.length > 0
    ? await db.from("app_users").select("clerk_user_id, handle").in("clerk_user_id", actorIds)
    : { data: [] };

  const actorMap = new Map<string, string>();
  for (const a of (actors ?? []) as { clerk_user_id: string; handle: string | null }[]) {
    if (a.handle) actorMap.set(a.clerk_user_id, a.handle);
  }

  type EventRow = { id: number; actor_id: string; event_type: string; canonical_slug: string | null; metadata: Record<string, unknown>; created_at: string };

  const recent: ActivityFeedItem[] = rows.map((e: EventRow) => {
    const handle = actorMap.get(e.actor_id) ?? "collector";
    return {
      id: e.id,
      actor: { id: e.actor_id, handle, avatar_initial: handle.slice(0, 1).toUpperCase() },
      event_type: e.event_type as ActivityFeedItem["event_type"],
      canonical_slug: e.canonical_slug,
      card_name: (e.metadata.card_name as string | null) ?? null,
      card_image_url: null,
      set_name: (e.metadata.set_name as string | null) ?? null,
      target_user: null,
      metadata: e.metadata,
      created_at: e.created_at,
      like_count: 0,
      comment_count: 0,
      liked_by_me: false,
    };
  });

  const res: CardFriendActivity = {
    ok: true,
    owner_count: uniqueOwners.size,
    recent,
  };
  return NextResponse.json(res);
}
