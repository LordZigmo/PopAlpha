import "server-only";
import { dbAdmin } from "@/lib/db/admin";
import {
  NotificationTypeV2,
  Subtype,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";

export type SubscriptionStatus =
  | "active"
  | "expired"
  | "revoked"
  | "grace_period"
  | "billing_retry";

export type AppleSubscriptionRow = {
  clerk_user_id: string;
  original_transaction_id: string;
  product_id: string;
  environment: "sandbox" | "production";
  status: SubscriptionStatus;
  expires_at: string | null;
  revoked_at: string | null;
  last_assn_at: string | null;
  raw_jws_payload: unknown;
};

type UpsertInput = Omit<AppleSubscriptionRow, "expires_at" | "revoked_at" | "last_assn_at" | "raw_jws_payload"> & {
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastAssnAt?: Date | null;
  rawJwsPayload?: unknown;
};

/**
 * Upsert an apple_subscriptions row keyed on original_transaction_id.
 *
 * If `lastAssnAt` is provided AND the existing row has a newer `last_assn_at`,
 * the upsert is skipped to protect against out-of-order ASSN V2 delivery.
 * The iOS-verify path passes no `lastAssnAt` and always wins (the device
 * just observed the transaction, so it's always the freshest signal we have).
 */
export async function upsertAppleSubscription(input: UpsertInput): Promise<{ skipped: boolean }> {
  const supabase = dbAdmin();

  if (input.lastAssnAt) {
    const { data: existing, error: readErr } = await supabase
      .from("apple_subscriptions")
      .select("last_assn_at")
      .eq("original_transaction_id", input.original_transaction_id)
      .maybeSingle();

    if (readErr) {
      console.error("[iap.upsert] read existing failed", { id: input.original_transaction_id, message: readErr.message });
      throw new Error("read existing apple_subscriptions row failed");
    }

    if (existing?.last_assn_at) {
      const existingMs = Date.parse(existing.last_assn_at);
      const incomingMs = input.lastAssnAt.getTime();
      if (Number.isFinite(existingMs) && existingMs >= incomingMs) {
        return { skipped: true };
      }
    }
  }

  const row: AppleSubscriptionRow = {
    clerk_user_id: input.clerk_user_id,
    original_transaction_id: input.original_transaction_id,
    product_id: input.product_id,
    environment: input.environment,
    status: input.status,
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    revoked_at: input.revokedAt ? input.revokedAt.toISOString() : null,
    last_assn_at: input.lastAssnAt ? input.lastAssnAt.toISOString() : null,
    raw_jws_payload: input.rawJwsPayload ?? null,
  };

  const { error: writeErr } = await supabase
    .from("apple_subscriptions")
    .upsert(row, { onConflict: "original_transaction_id" });

  if (writeErr) {
    console.error("[iap.upsert] write failed", { id: input.original_transaction_id, message: writeErr.message });
    throw new Error("apple_subscriptions upsert failed");
  }

  return { skipped: false };
}

/**
 * Update an existing apple_subscriptions row by original_transaction_id.
 *
 * Used by the ASSN V2 webhook, which observes events from Apple but does
 * NOT know the Clerk user ID — the row is expected to already exist
 * (created by the iOS /api/iap/verify path on initial purchase). Returns
 * `{ skipped: true, reason: "no_row" }` if no row exists, leaving the
 * webhook handler to log it without 500-ing.
 *
 * Like upsertAppleSubscription, an out-of-order ASSN delivery (older
 * lastAssnAt than the existing row) is silently skipped to keep the
 * canonical state monotonic.
 */
export async function updateAppleSubscriptionByTxnId(input: {
  original_transaction_id: string;
  status: SubscriptionStatus;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastAssnAt: Date;
  rawJwsPayload?: unknown;
}): Promise<{ skipped: boolean; reason?: "no_row" | "older" }> {
  const supabase = dbAdmin();

  const { data: existing, error: readErr } = await supabase
    .from("apple_subscriptions")
    .select("last_assn_at")
    .eq("original_transaction_id", input.original_transaction_id)
    .maybeSingle();

  if (readErr) {
    console.error("[iap.update] read existing failed", { id: input.original_transaction_id, message: readErr.message });
    throw new Error("read existing apple_subscriptions row failed");
  }

  if (!existing) {
    return { skipped: true, reason: "no_row" };
  }

  if (existing.last_assn_at) {
    const existingMs = Date.parse(existing.last_assn_at);
    if (Number.isFinite(existingMs) && existingMs >= input.lastAssnAt.getTime()) {
      return { skipped: true, reason: "older" };
    }
  }

  const { error: writeErr } = await supabase
    .from("apple_subscriptions")
    .update({
      status: input.status,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      revoked_at: input.revokedAt ? input.revokedAt.toISOString() : null,
      last_assn_at: input.lastAssnAt.toISOString(),
      raw_jws_payload: input.rawJwsPayload ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("original_transaction_id", input.original_transaction_id);

  if (writeErr) {
    console.error("[iap.update] write failed", { id: input.original_transaction_id, message: writeErr.message });
    throw new Error("apple_subscriptions update failed");
  }

  return { skipped: false };
}

/**
 * Map an ASSN V2 (notificationType, subtype) pair to a subscription status.
 * Returns null for notification types that don't change the entitlement
 * (renewal-pref toggles, price increase, test, consumption requests, etc.).
 */
export function statusFromNotification(
  notificationType: NotificationTypeV2 | string | undefined,
  subtype: Subtype | string | undefined,
): SubscriptionStatus | null {
  switch (notificationType) {
    case NotificationTypeV2.SUBSCRIBED:
    case NotificationTypeV2.DID_RENEW:
    case NotificationTypeV2.OFFER_REDEEMED:
    case NotificationTypeV2.RENEWAL_EXTENDED:
    case NotificationTypeV2.RENEWAL_EXTENSION:
    case NotificationTypeV2.REFUND_REVERSED:
    case NotificationTypeV2.ONE_TIME_CHARGE:
      return "active";
    case NotificationTypeV2.EXPIRED:
    case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
      return "expired";
    case NotificationTypeV2.DID_FAIL_TO_RENEW:
      return subtype === Subtype.GRACE_PERIOD ? "grace_period" : "billing_retry";
    case NotificationTypeV2.REVOKE:
    case NotificationTypeV2.REFUND:
    case NotificationTypeV2.RESCIND_CONSENT:
      return "revoked";
    default:
      return null;
  }
}

/**
 * Convert a JWSTransactionDecodedPayload's environment claim to our
 * narrow string literal. Throws on unrecognized values to fail closed.
 */
export function narrowEnvironment(value: string | undefined): "sandbox" | "production" {
  if (value === "Sandbox") return "sandbox";
  if (value === "Production") return "production";
  throw new Error(`Unrecognized App Store environment: ${value ?? "<missing>"}`);
}

/**
 * Status from an iOS-side decoded transaction. For iOS-verify, the device
 * has just observed a successful purchase, so the row is always "active"
 * unless the transaction itself carries a revocationDate (refunded after
 * the fact and the device hasn't caught up yet).
 */
export function statusFromTransaction(payload: JWSTransactionDecodedPayload): SubscriptionStatus {
  if (payload.revocationDate) return "revoked";
  return "active";
}

export type { JWSTransactionDecodedPayload, ResponseBodyV2DecodedPayload };
