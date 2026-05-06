import "server-only";
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";

/**
 * Apple JWS verification.
 *
 * Both ASSN V2 webhook payloads and iOS-side `Transaction.jwsRepresentation`
 * are JWS strings signed by Apple. Verification:
 *   1. Validates the x5c chain to one of the configured Apple root certs.
 *   2. Verifies the ES256 signature using the leaf cert's public key.
 *   3. Confirms `bid` matches our bundle ID.
 *   4. Confirms environment matches one we accept.
 *
 * Env vars:
 *   APP_STORE_BUNDLE_ID            — e.g. "ai.popalpha.ios"
 *   APP_STORE_APPLE_ROOT_CERTS_B64 — comma-separated base64 DER certs
 *                                    (Apple Root CA G3 covers prod + sandbox).
 *                                    Download from
 *                                    https://www.apple.com/certificateauthority/
 *   APP_STORE_APP_APPLE_ID         — numeric Apple App ID (optional in sandbox,
 *                                    required in production)
 *
 * We maintain both a production and sandbox verifier and try them in turn,
 * since the same endpoint receives both during sandbox testing and production
 * traffic. A valid JWS produced under one environment will fail on the
 * other with INVALID_ENVIRONMENT — the fallback path catches that.
 */

let cachedVerifiers: { production: SignedDataVerifier; sandbox: SignedDataVerifier } | null = null;

function getVerifiers(): { production: SignedDataVerifier; sandbox: SignedDataVerifier } {
  if (cachedVerifiers) return cachedVerifiers;

  const bundleId = process.env.APP_STORE_BUNDLE_ID?.trim();
  if (!bundleId) {
    throw new Error("APP_STORE_BUNDLE_ID env var is required for IAP verification.");
  }

  const rootCertsB64 = process.env.APP_STORE_APPLE_ROOT_CERTS_B64?.trim();
  if (!rootCertsB64) {
    throw new Error(
      "APP_STORE_APPLE_ROOT_CERTS_B64 env var is required (base64 DER certs, comma-separated).",
    );
  }

  const rootCerts = rootCertsB64
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b64) => Buffer.from(b64, "base64"));

  if (rootCerts.length === 0) {
    throw new Error("APP_STORE_APPLE_ROOT_CERTS_B64 parsed to zero certs.");
  }

  const appAppleIdRaw = process.env.APP_STORE_APP_APPLE_ID?.trim();
  const appAppleId = appAppleIdRaw ? Number(appAppleIdRaw) : undefined;
  if (appAppleIdRaw && !Number.isFinite(appAppleId)) {
    throw new Error(`APP_STORE_APP_APPLE_ID must be numeric, got "${appAppleIdRaw}".`);
  }

  cachedVerifiers = {
    production: new SignedDataVerifier(rootCerts, true, Environment.PRODUCTION, bundleId, appAppleId),
    sandbox: new SignedDataVerifier(rootCerts, true, Environment.SANDBOX, bundleId, appAppleId),
  };
  return cachedVerifiers;
}

async function tryBothEnvs<T>(
  invoke: (verifier: SignedDataVerifier) => Promise<T>,
): Promise<T> {
  const { production, sandbox } = getVerifiers();
  try {
    return await invoke(production);
  } catch (err) {
    if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
      return await invoke(sandbox);
    }
    throw err;
  }
}

/**
 * Verify and decode an iOS-side `Transaction.jwsRepresentation`.
 * Used by /api/iap/verify when the client posts a purchased transaction.
 */
export async function verifyAndDecodeTransaction(jws: string): Promise<JWSTransactionDecodedPayload> {
  return tryBothEnvs((v) => v.verifyAndDecodeTransaction(jws));
}

/**
 * Verify and decode an ASSN V2 webhook `signedPayload`.
 * Used by /api/webhooks/apple/notifications.
 */
export async function verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload> {
  return tryBothEnvs((v) => v.verifyAndDecodeNotification(signedPayload));
}

export { VerificationException, VerificationStatus, Environment };
