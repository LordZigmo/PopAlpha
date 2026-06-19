import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Identity for an activity actor / comment author / notification source.
 * `avatarUrl` is the user's PopAlpha-stored avatar (app_users.profile_image_url),
 * null when they haven't set one — UIs fall back to a handle monogram.
 */
export type ActorProfile = {
  handle: string | null;
  avatarUrl: string | null;
};

/**
 * Single source of truth for hydrating actor identity across the activity
 * routes (feed, profile, notifications, comments, card). Keeping the
 * app_users select in one place means avatar support can't drift between
 * the surfaces that render the same person.
 *
 * Returns a map keyed by clerk_user_id. Deduplicates and drops empty ids;
 * returns an empty map (no query) when there's nothing to look up.
 */
export async function fetchActorProfiles(
  db: SupabaseClient,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, ActorProfile>> {
  const map = new Map<string, ActorProfile>();
  const ids = [...new Set(userIds)].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return map;

  const { data } = await db
    .from("app_users")
    .select("clerk_user_id, handle, profile_image_url")
    .in("clerk_user_id", ids);

  for (const row of (data ?? []) as {
    clerk_user_id: string;
    handle: string | null;
    profile_image_url: string | null;
  }[]) {
    map.set(row.clerk_user_id, { handle: row.handle, avatarUrl: row.profile_image_url });
  }
  return map;
}
