import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser } from "@/lib/data/app-user";
import { verifyAndDecodeTransaction, VerificationException } from "@/lib/iap/jws-verify";
import {
  narrowEnvironment,
  statusFromTransaction,
  upsertAppleSubscription,
} from "@/lib/iap/upsert-subscription";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";

/**
 * iOS-side IAP verification.
 *
 * Called from PremiumStore on successful purchase. The client posts the
 * `Transaction.jwsRepresentation` from StoreKit; we verify the JWS chain,
 * extract the canonical fields (originalTransactionId, productId, expires,
 * environment), associate the row with the requesting Clerk user, and
 * return the resulting isPro state for instant client unlock.
 *
 * The ASSN V2 webhook keeps the row fresh between purchases (renewals,
 * cancellations, refunds). Both writers converge on apple_subscriptions
 * keyed by original_transaction_id.
 */
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: { jwsRepresentation?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const jws = typeof body.jwsRepresentation === "string" ? body.jwsRepresentation.trim() : "";
  if (!jws) {
    return NextResponse.json(
      { ok: false, error: "Missing jwsRepresentation." },
      { status: 400 },
    );
  }

  const posthog = getPostHogClient();

  let payload;
  try {
    payload = await verifyAndDecodeTransaction(jws);
  } catch (err) {
    if (err instanceof VerificationException) {
      console.warn("[iap/verify] JWS verification failed", {
        userId: auth.userId,
        status: err.status,
      });
      posthog.capture({
        distinctId: auth.userId,
        event: "subscription_verification_failed",
        properties: { reason: "jws_verification", apple_status: err.status },
      });
      return NextResponse.json(
        { ok: false, error: "Receipt verification failed." },
        { status: 400 },
      );
    }
    console.error("[iap/verify] verify error", { userId: auth.userId, err });
    posthog.capture({
      distinctId: auth.userId,
      event: "subscription_verification_failed",
      properties: { reason: "internal_error" },
    });
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  if (!payload.originalTransactionId || !payload.productId) {
    posthog.capture({
      distinctId: auth.userId,
      event: "subscription_verification_failed",
      properties: { reason: "missing_fields" },
    });
    return NextResponse.json(
      { ok: false, error: "Receipt missing required fields." },
      { status: 400 },
    );
  }

  let environment: "sandbox" | "production";
  try {
    environment = narrowEnvironment(payload.environment as string | undefined);
  } catch {
    posthog.capture({
      distinctId: auth.userId,
      event: "subscription_verification_failed",
      properties: { reason: "unrecognized_environment", env_raw: String(payload.environment ?? "") },
    });
    return NextResponse.json(
      { ok: false, error: "Receipt environment unrecognized." },
      { status: 400 },
    );
  }

  await ensureAppUser(auth.userId);

  const expiresAt = payload.expiresDate ? new Date(payload.expiresDate) : null;
  const status = statusFromTransaction(payload);

  try {
    await upsertAppleSubscription({
      clerk_user_id: auth.userId,
      original_transaction_id: payload.originalTransactionId,
      product_id: payload.productId,
      environment,
      status,
      expiresAt,
      revokedAt: payload.revocationDate ? new Date(payload.revocationDate) : null,
      rawJwsPayload: payload as unknown,
    });
  } catch (err) {
    console.error("[iap/verify] upsert failed", { userId: auth.userId, err });
    posthog.capture({
      distinctId: auth.userId,
      event: "subscription_verification_failed",
      properties: { reason: "upsert_failed", product_id: payload.productId },
    });
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const isPro = status === "active" && (expiresAt === null || expiresAt.getTime() > Date.now());

  // Server-authoritative subscription event. Pairs with the iOS-side
  // paywall_subscribed: a discrepancy (client fires, server doesn't)
  // signals receipt-tampering or a network failure to be investigated.
  posthog.capture({
    distinctId: auth.userId,
    event: "subscription_verified_server",
    properties: {
      product_id: payload.productId,
      status,
      environment,
      is_pro: isPro,
      expires_at: expiresAt?.toISOString() ?? null,
      revoked: payload.revocationDate != null,
    },
  });

  return NextResponse.json({
    ok: true,
    isPro,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
}
