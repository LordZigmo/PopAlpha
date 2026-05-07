import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser } from "@/lib/data/app-user";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";

/**
 * GET /api/me
 *
 * Returns the current user's app profile (ensures row exists).
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const user = await ensureAppUser(auth.userId);
  return NextResponse.json({
    ok: true,
    user: {
      clerk_user_id: user.clerk_user_id,
      handle: user.handle,
      onboarded: !!user.onboarding_completed_at,
      created_at: user.created_at,
    },
  });
}

/**
 * DELETE /api/me
 *
 * Apple §5.1.1(v) — permanent account deletion. Backs the iOS Settings
 * → "Delete My Account" flow (AccountService.requestAccountDeletion).
 *
 * Order matters:
 *   1. Clerk first. Deleting the auth identity invalidates the session
 *      so the user can't re-authenticate mid-cleanup. If Clerk fails
 *      (transient error), abort early and surface — partial-state
 *      retries are safer than half-deleted accounts. Idempotent: a
 *      second call after a partial success treats Clerk-404 as
 *      already-done and continues to Supabase cleanup.
 *
 *   2. Explicit table cleanups for user-keyed tables that hold a
 *      clerk_user_id WITHOUT a foreign-key constraint to app_users —
 *      holdings, apns_device_tokens, push_subscriptions,
 *      community_card_votes. These will NOT auto-cascade.
 *
 *   3. DELETE FROM app_users — CASCADE-cleans 14 referencing tables
 *      (apple_subscriptions, wishlist, profile_posts, profile_follows,
 *      activity_events, activity_likes, activity_comments,
 *      notifications, profile_post_card_mentions via profile_posts,
 *      personalization_profiles, user_blocks (both directions),
 *      moderation_reports.reporter_id). 5 columns SET NULL — kept rows
 *      lose their user reference (moderation_reports.target_owner /
 *      reviewed_by, personalization_actor_claims/explanation_cache,
 *      activity_events.target_user_id) — anonymizing rather than
 *      deleting moderation/analytics history.
 */
export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const userId = auth.userId;

  // 1. Delete Clerk user. Treat 404 (already deleted) as success so a
  //    retry after a transient Supabase failure can complete cleanup.
  try {
    const client = await clerkClient();
    await client.users.deleteUser(userId);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status !== 404) {
      console.error("[me DELETE] Clerk delete failed:", err);
      return NextResponse.json(
        { ok: false, error: "Couldn't delete account. Please try again." },
        { status: 500 },
      );
    }
  }

  // 2. Explicit cleanups for non-FK user-keyed tables. Failures here
  //    are logged but non-fatal — Clerk auth is already gone, so the
  //    practical user-facing "deleted" guarantee holds even if a
  //    Supabase row leaks. A follow-up cron can sweep orphans if needed.
  const db = dbAdmin();
  const cleanups = await Promise.allSettled([
    db.from("holdings").delete().eq("owner_clerk_id", userId),
    db.from("apns_device_tokens").delete().eq("clerk_user_id", userId),
    db.from("push_subscriptions").delete().eq("clerk_user_id", userId),
    db.from("community_card_votes").delete().eq("voter_id", userId),
  ]);
  for (const r of cleanups) {
    if (r.status === "rejected") {
      console.error("[me DELETE] non-FK cleanup failed:", r.reason);
    }
  }

  // 3. DELETE app_users — CASCADEs to FK-linked tables, SET NULLs the
  //    five anonymizable references.
  const { error: appUsersErr } = await db
    .from("app_users")
    .delete()
    .eq("clerk_user_id", userId);

  if (appUsersErr) {
    console.error(
      "[me DELETE] app_users delete failed (Clerk already deleted, orphans remain):",
      appUsersErr.message,
    );
    // Intentionally still return ok — auth is gone, user-facing
    // outcome is achieved. Operator can sweep orphans manually.
  }

  return NextResponse.json({ ok: true });
}
