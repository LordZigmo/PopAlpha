import "server-only";

import type { ActivityEventType } from "./types";

/**
 * Emit an activity event. Fire-and-forget — failures are logged but never
 * block the primary action. Uses the user-authenticated Supabase client so
 * RLS INSERT policy is satisfied (actor_id = requesting_clerk_user_id()).
 */
export async function emitActivityEvent(opts: {
  actorId: string;
  eventType: ActivityEventType;
  canonicalSlug?: string | null;
  targetUserId?: string | null;
  metadata?: Record<string, unknown>;
  visibility?: "public" | "followers" | "private";
}): Promise<void> {
  try {
    const { createServerSupabaseUserClient } = await import("@/lib/db/user");
    const db = await createServerSupabaseUserClient();

    // Resolve visibility: use explicit value if provided, otherwise respect user preference
    let visibility = opts.visibility;
    if (!visibility) {
      const { data: userRow } = await db
        .from("app_users")
        .select("activity_visibility")
        .eq("clerk_user_id", opts.actorId)
        .maybeSingle();
      visibility = (userRow?.activity_visibility as typeof visibility) ?? "public";
    }

    const today = new Date().toISOString().slice(0, 10);
    const dedupeKey = [
      opts.actorId,
      opts.eventType,
      opts.canonicalSlug ?? "_",
      opts.targetUserId ?? "_",
      today,
    ].join(":");

    await db.from("activity_events").upsert(
      {
        actor_id: opts.actorId,
        event_type: opts.eventType,
        canonical_slug: opts.canonicalSlug ?? null,
        target_user_id: opts.targetUserId ?? null,
        metadata: opts.metadata ?? {},
        visibility,
        dedupe_key: dedupeKey,
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  } catch (err) {
    console.error("[activity:emit] Failed to emit event:", err);
  }
}

/**
 * Create a notification for a user. Fire-and-forget.
 */
export async function emitNotification(opts: {
  recipientId: string;
  actorId: string;
  type: "like" | "comment" | "follow";
  eventId?: number | null;
}): Promise<void> {
  if (opts.recipientId === opts.actorId) return; // don't notify self
  try {
    const { createServerSupabaseUserClient } = await import("@/lib/db/user");
    const db = await createServerSupabaseUserClient();

    await db.from("notifications").insert({
      recipient_id: opts.recipientId,
      actor_id: opts.actorId,
      type: opts.type,
      event_id: opts.eventId ?? null,
    });
  } catch (err) {
    console.error("[activity:notify] Failed to create notification:", err);
  }
}
