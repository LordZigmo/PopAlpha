/**
 * App user provisioning for authenticated users.
 *
 * Uses dbAdmin() because the iOS app sends a Clerk Bearer JWT that
 * Supabase RLS cannot validate (no JWT template configured on this
 * project). Every caller of these helpers gates on requireUser() first
 * and every query here filters by clerk_user_id explicitly — same
 * isolation guarantees RLS would provide. Matches the pattern used
 * by /api/holdings/route.ts and /api/device/register/route.ts.
 */

import { dbAdmin } from "@/lib/db/admin";

export type AppUser = {
  clerk_user_id: string;
  handle: string | null;
  handle_norm: string | null;
  created_at: string;
  onboarding_completed_at: string | null;
  profile_bio: string | null;
  profile_banner_url: string | null;
  notify_price_alerts: boolean;
  notify_weekly_digest: boolean;
  notify_product_updates: boolean;
  /** 0–23, interpreted in `notification_delivery_timezone`. */
  notification_delivery_hour: number;
  /** 0–59, interpreted in `notification_delivery_timezone`. */
  notification_delivery_minute: number;
  /** IANA timezone name (e.g. "America/New_York"). Defaults to "UTC". */
  notification_delivery_timezone: string;
  profile_visibility: "PUBLIC" | "PRIVATE";
};

const APP_USER_SELECT =
  "clerk_user_id, handle, handle_norm, created_at, onboarding_completed_at, profile_bio, profile_banner_url, notify_price_alerts, notify_weekly_digest, notify_product_updates, notification_delivery_hour, notification_delivery_minute, notification_delivery_timezone, profile_visibility";

/**
 * Upsert an app_users row for the given Clerk user.
 * Returns the full row (creates if missing, returns existing otherwise).
 */
export async function ensureAppUser(clerkUserId: string): Promise<AppUser> {
  const db = dbAdmin();
  const { data, error } = await db
    .from("app_users")
    .upsert({ clerk_user_id: clerkUserId }, { onConflict: "clerk_user_id" })
    .select(APP_USER_SELECT)
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
    .select(APP_USER_SELECT)
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
      .select(APP_USER_SELECT)
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

export async function updateAppProfile(
  clerkUserId: string,
  updates: {
    handle?: string;
    handleNorm?: string;
    profileBio?: string | null;
    profileBannerUrl?: string | null;
    notifyPriceAlerts?: boolean;
    notifyWeeklyDigest?: boolean;
    notifyProductUpdates?: boolean;
    notificationDeliveryHour?: number;
    notificationDeliveryMinute?: number;
    notificationDeliveryTimezone?: string;
    profileVisibility?: "PUBLIC" | "PRIVATE";
  },
): Promise<AppUser | null> {
  const db = dbAdmin();
  const payload: Record<string, unknown> = {};

  if (typeof updates.handle === "string") payload.handle = updates.handle;
  if (typeof updates.handleNorm === "string") payload.handle_norm = updates.handleNorm;
  if ("profileBio" in updates) payload.profile_bio = updates.profileBio ?? null;
  if ("profileBannerUrl" in updates) payload.profile_banner_url = updates.profileBannerUrl ?? null;
  if (typeof updates.notifyPriceAlerts === "boolean") payload.notify_price_alerts = updates.notifyPriceAlerts;
  if (typeof updates.notifyWeeklyDigest === "boolean") payload.notify_weekly_digest = updates.notifyWeeklyDigest;
  if (typeof updates.notifyProductUpdates === "boolean") payload.notify_product_updates = updates.notifyProductUpdates;
  if (typeof updates.notificationDeliveryHour === "number") {
    payload.notification_delivery_hour = updates.notificationDeliveryHour;
  }
  if (typeof updates.notificationDeliveryMinute === "number") {
    payload.notification_delivery_minute = updates.notificationDeliveryMinute;
  }
  if (typeof updates.notificationDeliveryTimezone === "string") {
    payload.notification_delivery_timezone = updates.notificationDeliveryTimezone;
  }
  if (typeof updates.profileVisibility === "string") payload.profile_visibility = updates.profileVisibility;
  if (Object.keys(payload).length === 0) return getAppUser(clerkUserId);

  try {
    const { data, error } = await db
      .from("app_users")
      .update(payload)
      .eq("clerk_user_id", clerkUserId)
      .select(APP_USER_SELECT)
      .single();

    if (error) {
      if (error.code === "23505") return null;
      throw error;
    }
    return data as AppUser;
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") return null;
    throw err;
  }
}
