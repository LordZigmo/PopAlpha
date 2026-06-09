import "server-only";
import { dbAdmin } from "@/lib/db/admin";
import { getPostHogClient } from "@/lib/posthog-server";

/**
 * Server-side entitlement check.
 *
 * Reads from `apple_subscriptions` (RLS denies anon; service-role only).
 * A user is "pro" if they have any active subscription whose expiration
 * is unset or in the future. Revoked rows are filtered by status, so
 * refunds + chargebacks remove the entitlement.
 *
 * Called from gated API routes; must be awaited. Cheap point lookup
 * via the (clerk_user_id, status, expires_at) index.
 */
export async function hasPro(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("apple_subscriptions")
    .select("original_transaction_id, expires_at")
    .eq("clerk_user_id", userId)
    .eq("status", "active")
    .limit(50);

  if (error) {
    console.error("[entitlements] hasPro lookup failed", { userId, message: error.message });
    // Fail-closed is correct (never leak paid content), but it means a
    // Supabase blip locks paying users out of Pro surfaces. Emit a
    // PostHog event so a spike is visible on a dashboard/alert instead
    // of only in per-request logs. Must never throw from this path.
    try {
      getPostHogClient().capture({
        distinctId: userId,
        event: "entitlement_check_failed",
        properties: { message: error.message },
      });
    } catch {
      // Telemetry failure must not affect the entitlement decision.
    }
    return false;
  }

  if (!data || data.length === 0) return false;

  const now = Date.now();
  return data.some((row) => row.expires_at == null || Date.parse(row.expires_at) > now);
}
