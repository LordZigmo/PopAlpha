/**
 * Helper: fetch the set of clerk_user_ids that have a block relationship
 * with the requester (in either direction).
 *
 * Apple Guideline 1.2 requires that when user A blocks user B:
 *   - A no longer sees B's content (forward filter)
 *   - B no longer sees A's content or interaction (reverse filter)
 *
 * Routes that hydrate other users' content (feed, comments, profile,
 * notifications) call this once and use the returned set as a filter
 * over actor_id / author_id / target_user_id.
 *
 * Returns an empty array on any DB error so a transient failure doesn't
 * blow up the read path; the worst case is "block didn't apply on this
 * one request," which is bounded and safer than 500-ing the feed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function getBlockedUserIds(
  db: SupabaseClient,
  selfId: string,
): Promise<string[]> {
  if (!selfId) return [];

  const [forwardRes, reverseRes] = await Promise.all([
    db.from("user_blocks").select("blocked_id").eq("blocker_id", selfId),
    db.from("user_blocks").select("blocker_id").eq("blocked_id", selfId),
  ]);

  const ids = new Set<string>();
  for (const r of (forwardRes.data ?? []) as { blocked_id: string }[]) {
    ids.add(r.blocked_id);
  }
  for (const r of (reverseRes.data ?? []) as { blocker_id: string }[]) {
    ids.add(r.blocker_id);
  }
  return [...ids];
}

/**
 * Returns true if `selfId` and `targetId` have a block relationship in
 * either direction. Used by the profile route to short-circuit instead
 * of returning empty data.
 */
export async function isBlockedEitherWay(
  db: SupabaseClient,
  selfId: string,
  targetId: string,
): Promise<boolean> {
  if (!selfId || !targetId || selfId === targetId) return false;

  const { data } = await db
    .from("user_blocks")
    .select("blocker_id")
    .or(`and(blocker_id.eq.${selfId},blocked_id.eq.${targetId}),and(blocker_id.eq.${targetId},blocked_id.eq.${selfId})`)
    .limit(1);

  return (data?.length ?? 0) > 0;
}
