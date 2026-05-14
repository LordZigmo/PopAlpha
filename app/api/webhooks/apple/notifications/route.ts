import { NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db/admin";
import {
  verifyAndDecodeNotification,
  verifyAndDecodeTransaction,
  VerificationException,
} from "@/lib/iap/jws-verify";
import {
  narrowEnvironment,
  statusFromNotification,
  updateAppleSubscriptionByTxnId,
} from "@/lib/iap/upsert-subscription";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";

/**
 * App Store Server Notifications V2 webhook.
 *
 * Apple posts a JSON body of `{ signedPayload: string }`. We verify the
 * payload's JWS chain, decode the notification, and (if it carries a
 * subscription state change) update the apple_subscriptions row keyed by
 * the inner transaction's originalTransactionId.
 *
 * The row is expected to already exist — created by /api/iap/verify on
 * the user's first purchase. If the webhook arrives for a transaction we
 * never saw from iOS (clean install on a new device, or iOS-verify failed
 * silently), we acknowledge with `{ ok: true, applied: false }` so Apple
 * doesn't retry forever; the next iOS launch will rehydrate the row via
 * /api/iap/verify against the current Transaction.currentEntitlements.
 *
 * Apple expects HTTP 200 for any successful delivery; non-2xx triggers
 * exponential retries up to ~3 days. Verification failures return 400 to
 * prevent retry loops on tampered payloads.
 */
export async function POST(req: Request) {
  let body: { signedPayload?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const signedPayload = typeof body.signedPayload === "string" ? body.signedPayload.trim() : "";
  if (!signedPayload) {
    return NextResponse.json({ ok: false, error: "Missing signedPayload." }, { status: 400 });
  }

  let notification;
  try {
    notification = await verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    if (err instanceof VerificationException) {
      console.warn("[iap/webhook] notification verification failed", { status: err.status });
      return NextResponse.json({ ok: false, error: "Verification failed." }, { status: 400 });
    }
    console.error("[iap/webhook] verify error", { err });
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const notificationType = notification.notificationType;
  const subtype = notification.subtype;
  const signedDateMs = notification.signedDate;
  const innerJws = notification.data?.signedTransactionInfo;

  if (!innerJws) {
    // Notifications without transaction data (TEST, EXTERNAL_PURCHASE_TOKEN-only,
    // some summary notifications). Acknowledge without applying.
    console.info("[iap/webhook] no signedTransactionInfo", {
      notificationType,
      subtype,
      uuid: notification.notificationUUID,
    });
    return NextResponse.json({ ok: true, applied: false, reason: "no_txn" });
  }

  let txn;
  try {
    txn = await verifyAndDecodeTransaction(innerJws);
  } catch (err) {
    if (err instanceof VerificationException) {
      console.warn("[iap/webhook] inner txn verification failed", { status: err.status });
      return NextResponse.json({ ok: false, error: "Inner verification failed." }, { status: 400 });
    }
    console.error("[iap/webhook] inner verify error", { err });
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const status = statusFromNotification(notificationType, subtype);
  if (!status || !txn.originalTransactionId) {
    console.info("[iap/webhook] no entitlement change", {
      notificationType,
      subtype,
      uuid: notification.notificationUUID,
    });
    return NextResponse.json({ ok: true, applied: false, reason: "no_status_change" });
  }

  // Sanity check: bundle-id and environment are validated inside the
  // library against the configured verifier, but we still ensure the
  // inner txn environment matches a known value before persisting.
  try {
    narrowEnvironment(txn.environment as string | undefined);
  } catch {
    console.warn("[iap/webhook] inner txn environment unrecognized", { env: txn.environment });
    return NextResponse.json({ ok: false, error: "Environment unrecognized." }, { status: 400 });
  }

  const lastAssnAt = signedDateMs ? new Date(signedDateMs) : new Date();
  const expiresAt = txn.expiresDate ? new Date(txn.expiresDate) : null;
  const revokedAt = txn.revocationDate ? new Date(txn.revocationDate) : null;

  try {
    const result = await updateAppleSubscriptionByTxnId({
      original_transaction_id: txn.originalTransactionId,
      status,
      expiresAt,
      revokedAt,
      lastAssnAt,
      rawJwsPayload: { notification, txn } as unknown,
    });

    if (result.skipped) {
      console.info("[iap/webhook] skipped", {
        notificationType,
        subtype,
        reason: result.reason,
        originalTransactionId: txn.originalTransactionId,
      });
      return NextResponse.json({ ok: true, applied: false, reason: result.reason });
    }

    console.info("[iap/webhook] applied", {
      notificationType,
      subtype,
      status,
      originalTransactionId: txn.originalTransactionId,
    });

    // Subscription lifecycle event — the canonical record of every
    // ASSN-driven status transition (DID_RENEW / EXPIRED / REVOKE
    // / REFUND / GRACE_PERIOD_EXPIRED / etc.). These cannot be
    // tracked client-side. Distinct ID = clerk_user_id from the
    // updated row so the events join cleanly with iOS-side
    // paywall_subscribed in PostHog funnels. If the lookup fails
    // (race against deletion), we fall back to the
    // original_transaction_id namespace so the event isn't lost.
    const { data: subRow } = await dbAdmin()
      .from("apple_subscriptions")
      .select("clerk_user_id, product_id")
      .eq("original_transaction_id", txn.originalTransactionId)
      .maybeSingle();

    getPostHogClient().capture({
      distinctId: subRow?.clerk_user_id ?? `anonymous:${txn.originalTransactionId}`,
      event: "subscription_status_changed",
      properties: {
        notification_type: notificationType,
        subtype: subtype ?? null,
        status,
        product_id: subRow?.product_id ?? null,
        original_transaction_id: txn.originalTransactionId,
        expires_at: expiresAt?.toISOString() ?? null,
        revoked: revokedAt != null,
      },
    });

    return NextResponse.json({ ok: true, applied: true });
  } catch (err) {
    console.error("[iap/webhook] update failed", { err });
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
}
