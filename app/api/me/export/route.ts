import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";

export const runtime = "nodejs";

/**
 * GET /api/me/export
 *
 * Export all user data as a JSON bundle (Apple data portability compliance).
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const db = await createServerSupabaseUserClient();
  const uid = auth.userId;

  try {
    const [
      profileRes,
      holdingsRes,
      wishlistRes,
      activityRes,
      postsRes,
    ] = await Promise.all([
      db.from("app_users")
        .select("clerk_user_id, handle, profile_bio, profile_banner_url, activity_visibility, profile_visibility, notify_price_alerts, notify_weekly_digest, notify_product_updates, created_at")
        .eq("clerk_user_id", uid)
        .maybeSingle(),

      db.from("holdings")
        .select("id, canonical_slug, printing_id, grade, qty, price_paid_usd, acquired_on, venue, cert_number, created_at")
        .eq("owner_clerk_id", uid)
        .order("created_at", { ascending: false }),

      db.from("wishlist_items")
        .select("id, canonical_slug, note, created_at")
        .eq("owner_id", uid)
        .order("created_at", { ascending: false }),

      db.from("activity_events")
        .select("id, event_type, canonical_slug, target_user_id, metadata, visibility, created_at")
        .eq("actor_id", uid)
        .order("created_at", { ascending: false })
        .limit(500),

      db.from("profile_posts")
        .select("id, body, created_at")
        .eq("owner_id", uid)
        .order("created_at", { ascending: false }),
    ]);

    const exportData = {
      profile: profileRes.data ?? null,
      holdings: holdingsRes.data ?? [],
      wishlist: wishlistRes.data ?? [],
      activity: activityRes.data ?? [],
      posts: postsRes.data ?? [],
      exportedAt: new Date().toISOString(),
    };

    return NextResponse.json({ ok: true, data: exportData });
  } catch (error) {
    console.error("[me/export GET]", error);
    return NextResponse.json(
      { ok: false, error: "Failed to export data." },
      { status: 500 },
    );
  }
}
