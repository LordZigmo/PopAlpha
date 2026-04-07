import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import type { ActivityFeedItem, ActivityFeedResponse } from "@/lib/activity/types";

export const runtime = "nodejs";

/**
 * GET /api/activity/feed?cursor=&limit=
 * Paginated activity feed: events from followed users + own events.
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor") || "0") || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") || "20") || 20, 50);

  const db = await createServerSupabaseUserClient();

  // Get IDs of users we follow
  const { data: followRows } = await db
    .from("profile_follows")
    .select("followee_id")
    .eq("follower_id", auth.userId);

  const followedIds = (followRows ?? []).map((r: { followee_id: string }) => r.followee_id);
  const feedUserIds = [...followedIds, auth.userId];

  // Fetch events
  let query = db
    .from("activity_events")
    .select("id, actor_id, event_type, canonical_slug, target_user_id, metadata, visibility, created_at")
    .in("actor_id", feedUserIds)
    .order("created_at", { ascending: false })
    .limit(limit + 1); // fetch one extra for cursor

  if (cursor > 0) {
    query = query.lt("id", cursor);
  }

  const { data: events, error } = await query;
  if (error) {
    console.error("[activity/feed]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const rows = events ?? [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  if (pageRows.length === 0) {
    const res: ActivityFeedResponse = { ok: true, items: [], next_cursor: null };
    return NextResponse.json(res);
  }

  // Hydrate: actor handles, card names, card images, like/comment counts
  const eventIds = pageRows.map((e: { id: number }) => e.id);
  const actorIds = [...new Set(pageRows.map((e: { actor_id: string }) => e.actor_id))];
  const targetUserIds = [
    ...new Set(pageRows.filter((e: { target_user_id: string | null }) => e.target_user_id).map((e: { target_user_id: string | null }) => e.target_user_id!)),
  ];
  const slugs = [
    ...new Set(pageRows.filter((e: { canonical_slug: string | null }) => e.canonical_slug).map((e: { canonical_slug: string | null }) => e.canonical_slug!)),
  ];

  const [actorsRes, targetsRes, cardsRes, imagesRes, likesRes, commentsRes, myLikesRes] =
    await Promise.all([
      db
        .from("app_users")
        .select("clerk_user_id, handle")
        .in("clerk_user_id", actorIds),
      targetUserIds.length > 0
        ? db.from("app_users").select("clerk_user_id, handle").in("clerk_user_id", targetUserIds)
        : Promise.resolve({ data: [] }),
      slugs.length > 0
        ? db.from("canonical_cards").select("slug, canonical_name, set_name").in("slug", slugs)
        : Promise.resolve({ data: [] }),
      slugs.length > 0
        ? db
            .from("card_printings")
            .select("canonical_slug, image_url")
            .in("canonical_slug", slugs)
            .eq("language", "EN")
            .not("image_url", "is", null)
            .limit(slugs.length)
        : Promise.resolve({ data: [] }),
      // (like/comment counts fetched separately below)
      Promise.resolve(null),
      Promise.resolve(null),
      // My likes
      db
        .from("activity_likes")
        .select("event_id")
        .in("event_id", eventIds)
        .eq("user_id", auth.userId),
    ]);

  // Build lookup maps
  const actorMap = new Map<string, string>();
  for (const a of (actorsRes.data ?? []) as { clerk_user_id: string; handle: string | null }[]) {
    if (a.handle) actorMap.set(a.clerk_user_id, a.handle);
  }

  const targetMap = new Map<string, string>();
  for (const t of (targetsRes.data ?? []) as { clerk_user_id: string; handle: string | null }[]) {
    if (t.handle) targetMap.set(t.clerk_user_id, t.handle);
  }

  const cardMap = new Map<string, { name: string; set_name: string | null }>();
  for (const c of (cardsRes.data ?? []) as { slug: string; canonical_name: string; set_name: string | null }[]) {
    cardMap.set(c.slug, { name: c.canonical_name, set_name: c.set_name });
  }

  const imageMap = new Map<string, string>();
  for (const img of (imagesRes.data ?? []) as { canonical_slug: string; image_url: string | null }[]) {
    if (img.image_url && !imageMap.has(img.canonical_slug)) {
      imageMap.set(img.canonical_slug, img.image_url);
    }
  }

  const myLikedIds = new Set(
    ((myLikesRes.data ?? []) as { event_id: number }[]).map((r) => r.event_id),
  );

  // Get like & comment counts in bulk
  const [likeCounts, commentCounts] = await Promise.all([
    db
      .from("activity_likes")
      .select("event_id")
      .in("event_id", eventIds),
    db
      .from("activity_comments")
      .select("event_id")
      .in("event_id", eventIds),
  ]);

  const likeCountMap = new Map<number, number>();
  for (const r of (likeCounts.data ?? []) as { event_id: number }[]) {
    likeCountMap.set(r.event_id, (likeCountMap.get(r.event_id) ?? 0) + 1);
  }

  const commentCountMap = new Map<number, number>();
  for (const r of (commentCounts.data ?? []) as { event_id: number }[]) {
    commentCountMap.set(r.event_id, (commentCountMap.get(r.event_id) ?? 0) + 1);
  }

  // Assemble feed items
  type EventRow = {
    id: number;
    actor_id: string;
    event_type: string;
    canonical_slug: string | null;
    target_user_id: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  };

  const items: ActivityFeedItem[] = pageRows.map((e: EventRow) => {
    const handle = actorMap.get(e.actor_id) ?? "collector";
    const card = e.canonical_slug ? cardMap.get(e.canonical_slug) : null;
    const targetHandle = e.target_user_id ? targetMap.get(e.target_user_id) : null;

    return {
      id: e.id,
      actor: {
        id: e.actor_id,
        handle,
        avatar_initial: handle.slice(0, 1).toUpperCase(),
      },
      event_type: e.event_type as ActivityFeedItem["event_type"],
      canonical_slug: e.canonical_slug,
      card_name: card?.name ?? (e.metadata.card_name as string | null) ?? null,
      card_image_url: e.canonical_slug ? imageMap.get(e.canonical_slug) ?? null : null,
      set_name: card?.set_name ?? (e.metadata.set_name as string | null) ?? null,
      target_user: e.target_user_id && targetHandle
        ? { id: e.target_user_id, handle: targetHandle }
        : null,
      metadata: e.metadata,
      created_at: e.created_at,
      like_count: likeCountMap.get(e.id) ?? 0,
      comment_count: commentCountMap.get(e.id) ?? 0,
      liked_by_me: myLikedIds.has(e.id),
    };
  });

  const nextCursor = hasMore ? pageRows[pageRows.length - 1].id : null;
  const res: ActivityFeedResponse = { ok: true, items, next_cursor: nextCursor };
  return NextResponse.json(res);
}
