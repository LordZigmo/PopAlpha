import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import type { NotificationItem, NotificationsResponse } from "@/lib/activity/types";

export const runtime = "nodejs";

/**
 * GET /api/activity/notifications?cursor=&limit=
 * Paginated notifications for the authenticated user.
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor") || "0") || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") || "20") || 20, 50);

  const db = await createServerSupabaseUserClient();

  // Get unread count
  const { data: unreadRows } = await db
    .from("notifications")
    .select("id")
    .eq("recipient_id", auth.userId)
    .eq("read", false);

  const unreadCount = unreadRows?.length ?? 0;

  // Get notifications
  let query = db
    .from("notifications")
    .select("id, type, actor_id, event_id, read, created_at")
    .eq("recipient_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor > 0) {
    query = query.lt("id", cursor);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error("[activity/notifications]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const allRows = rows ?? [];
  const hasMore = allRows.length > limit;
  const pageRows = hasMore ? allRows.slice(0, limit) : allRows;

  // Hydrate actor handles
  const actorIds = [...new Set(pageRows.map((r: { actor_id: string }) => r.actor_id))];
  const { data: actors } = actorIds.length > 0
    ? await db.from("app_users").select("clerk_user_id, handle").in("clerk_user_id", actorIds)
    : { data: [] };

  const actorMap = new Map<string, string>();
  for (const a of (actors ?? []) as { clerk_user_id: string; handle: string | null }[]) {
    if (a.handle) actorMap.set(a.clerk_user_id, a.handle);
  }

  // Hydrate event types for notifications with event_id
  const eventIds = pageRows
    .filter((r: { event_id: number | null }) => r.event_id)
    .map((r: { event_id: number | null }) => r.event_id!);
  const { data: events } = eventIds.length > 0
    ? await db.from("activity_events").select("id, event_type").in("id", eventIds)
    : { data: [] };

  const eventTypeMap = new Map<number, string>();
  for (const e of (events ?? []) as { id: number; event_type: string }[]) {
    eventTypeMap.set(e.id, e.event_type);
  }

  type NotiRow = {
    id: number;
    type: string;
    actor_id: string;
    event_id: number | null;
    read: boolean;
    created_at: string;
  };

  const notifications: NotificationItem[] = pageRows.map((r: NotiRow) => ({
    id: r.id,
    type: r.type as NotificationItem["type"],
    actor: {
      id: r.actor_id,
      handle: actorMap.get(r.actor_id) ?? "collector",
    },
    event_id: r.event_id,
    event_type: r.event_id ? (eventTypeMap.get(r.event_id) as NotificationItem["event_type"]) ?? null : null,
    read: r.read,
    created_at: r.created_at,
  }));

  const nextCursor = hasMore ? pageRows[pageRows.length - 1].id : null;
  const res: NotificationsResponse = {
    ok: true,
    notifications,
    unread_count: unreadCount,
    next_cursor: nextCursor,
  };
  return NextResponse.json(res);
}
