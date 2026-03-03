/**
 * App user provisioning — uses dbAdmin().
 * Only import from API routes in the dbAdmin allowlist.
 */

import { dbAdmin } from "@/lib/db/admin";

export type AppUser = {
  clerk_user_id: string;
  handle: string | null;
  handle_norm: string | null;
  created_at: string;
  onboarding_completed_at: string | null;
};

/**
 * Upsert an app_users row for the given Clerk user.
 * Returns the full row (creates if missing, returns existing otherwise).
 */
export async function ensureAppUser(clerkUserId: string): Promise<AppUser> {
  const db = dbAdmin();
  const { data, error } = await db
    .from("app_users")
    .upsert({ clerk_user_id: clerkUserId }, { onConflict: "clerk_user_id" })
    .select("clerk_user_id, handle, handle_norm, created_at, onboarding_completed_at")
    .single();

  if (error) throw new Error(`ensureAppUser failed: ${error.message}`);
  return data as AppUser;
}

/**
 * Fetch an app_users row or null if it doesn't exist.
 */
export async function getAppUser(clerkUserId: string): Promise<AppUser | null> {
  const db = dbAdmin();
  const { data, error } = await db
    .from("app_users")
    .select("clerk_user_id, handle, handle_norm, created_at, onboarding_completed_at")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();

  if (error) throw new Error(`getAppUser failed: ${error.message}`);
  return data as AppUser | null;
}

/**
 * Check whether a normalized handle is already taken.
 */
export async function isHandleTaken(handleNorm: string): Promise<boolean> {
  const db = dbAdmin();
  const { count, error } = await db
    .from("app_users")
    .select("*", { count: "exact", head: true })
    .eq("handle_norm", handleNorm);

  if (error) throw new Error(`isHandleTaken failed: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * Claim a handle for a user. Only succeeds if the user hasn't already
 * claimed one (handle IS NULL guard) and the normalized handle is unique.
 *
 * Returns the updated AppUser on success, or null if the handle was taken
 * (catches Postgres 23505 unique violation).
 */
export async function claimHandle(
  clerkUserId: string,
  handle: string,
  handleNorm: string,
): Promise<AppUser | null> {
  const db = dbAdmin();
  try {
    const { data, error } = await db
      .from("app_users")
      .update({
        handle,
        handle_norm: handleNorm,
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq("clerk_user_id", clerkUserId)
      .is("handle", null)
      .select("clerk_user_id, handle, handle_norm, created_at, onboarding_completed_at")
      .single();

    if (error) {
      // Postgres unique violation — handle already taken
      if (error.code === "23505") return null;
      // No rows matched (user already has a handle)
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as AppUser;
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") return null;
    throw err;
  }
}
