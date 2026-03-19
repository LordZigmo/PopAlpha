import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  getPublicWriteIp,
  hashPublicWriteValue,
  logPublicWriteEvent,
  retryAfterSeconds,
} from "@/lib/public-write";
import { createRateLimiter } from "@/lib/rate-limit";
import { getEbayAppAccessToken, getEbayBaseUrl } from "@/lib/ebay/api";

export const EBAY_NOTIFICATION_SIGNATURE_HEADER = "x-ebay-signature";
export const EBAY_DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";
export const EBAY_NOTIFICATION_PUBLIC_KEY_CACHE_TTL_MS = 60 * 60_000;

const SUPPORTED_SIGNATURE_ALGORITHM = "ECDSA";
const SUPPORTED_SIGNATURE_DIGEST = "SHA1";
const EBAY_NOTIFICATION_PUBLIC_KEY_CACHE_MAX_ENTRIES = 32;

const webhookRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

type JsonRecord = Record<string, unknown>;

type EbaySignatureHeaderPayload = {
  alg: string;
  kid: string;
  signature: string;
  digest: string;
};

type EbayNotificationPublicKey = {
  algorithm: string;
  digest: string;
  key: string;
};

type EbayDeletionNotificationData = {
  username: string | null;
  userId: string;
  eiasToken: string | null;
};

export type EbayDeletionNotificationPayload = {
  metadata: {
    topic: string;
    schemaVersion: string;
  };
  notification: {
    notificationId: string;
    eventDate: string;
    publishDate: string;
    publishAttemptCount: number;
    data: EbayDeletionNotificationData;
  };
};

type EbayVerificationResult = {
  header: Pick<EbaySignatureHeaderPayload, "alg" | "kid" | "digest">;
  publicKey: Pick<EbayNotificationPublicKey, "algorithm" | "digest">;
  payloadSha256: string;
};

type PersistReceiptResult = {
  stored: boolean;
};

type PersistReceiptInput = {
  payload: EbayDeletionNotificationPayload;
  verification: EbayVerificationResult;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
};

type HandleEbayDeletionNotificationDependencies = {
  now?: () => number;
  rateLimit?: (key: string) => RateLimitResult;
  logEvent?: typeof logPublicWriteEvent;
  verifyNotification?: (input: {
    rawBody: Buffer;
    signatureHeader: string;
  }) => Promise<EbayVerificationResult>;
  persistReceipt: (input: PersistReceiptInput) => Promise<PersistReceiptResult>;
};

type PublicKeyCacheEntry = {
  value: EbayNotificationPublicKey;
  expiresAt: number;
  cachedAt: number;
};

const publicKeyCache = new Map<string, PublicKeyCacheEntry>();

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeBase64(
  value: string,
  field: string,
  kind: "malformed_public_key" | "malformed_signature_header" = "malformed_signature_header",
): Buffer {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(trimmed)) {
    throw new EbayDeletionNotificationError(kind, `${field} must be valid base64.`);
  }

  const buffer = Buffer.from(trimmed, "base64");
  if (buffer.length === 0) {
    throw new EbayDeletionNotificationError(kind, `${field} decoded to an empty value.`);
  }

  return buffer;
}

function requireString(value: unknown, field: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new EbayDeletionNotificationError("invalid_payload_shape", `${field} must be a non-empty string.`);
  }
  return normalized;
}

function parsePublishAttemptCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }

  throw new EbayDeletionNotificationError(
    "invalid_payload_shape",
    "notification.publishAttemptCount must be a positive integer.",
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSignatureHeader(signatureHeader: string): EbaySignatureHeaderPayload {
  const decoded = decodeBase64(signatureHeader, EBAY_NOTIFICATION_SIGNATURE_HEADER).toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new EbayDeletionNotificationError(
      "malformed_signature_header",
      `${EBAY_NOTIFICATION_SIGNATURE_HEADER} must decode to JSON.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new EbayDeletionNotificationError(
      "malformed_signature_header",
      `${EBAY_NOTIFICATION_SIGNATURE_HEADER} must decode to an object.`,
    );
  }

  return {
    alg: requireString(parsed.alg, "signature.alg"),
    kid: requireString(parsed.kid, "signature.kid"),
    signature: requireString(parsed.signature, "signature.signature"),
    digest: requireString(parsed.digest, "signature.digest"),
  };
}

function buildPublicKeyCacheKey(keyId: string, baseUrl: string): string {
  return `${baseUrl}::${keyId}`;
}

function trimExpiredPublicKeys(nowMs: number) {
  for (const [cacheKey, entry] of publicKeyCache) {
    if (entry.expiresAt <= nowMs) {
      publicKeyCache.delete(cacheKey);
    }
  }
}

function prunePublicKeyCache(nowMs: number) {
  trimExpiredPublicKeys(nowMs);
  if (publicKeyCache.size < EBAY_NOTIFICATION_PUBLIC_KEY_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestEntry = [...publicKeyCache.entries()]
    .sort((left, right) => left[1].cachedAt - right[1].cachedAt)[0];
  if (oldestEntry) {
    publicKeyCache.delete(oldestEntry[0]);
  }
}

export function resetEbayNotificationPublicKeyCacheForTests() {
  publicKeyCache.clear();
}

export async function loadEbayNotificationPublicKey(
  keyId: string,
  {
    fetchImpl = fetch,
    now = () => Date.now(),
    baseUrl = getEbayBaseUrl(),
    getAccessToken = getEbayAppAccessToken,
  }: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    baseUrl?: string;
    getAccessToken?: (fetchImpl?: typeof fetch) => Promise<string>;
  } = {},
): Promise<EbayNotificationPublicKey> {
  const cacheKey = normalizeText(keyId);
  if (!cacheKey) {
    throw new EbayDeletionNotificationError("malformed_signature_header", "signature.kid is required.");
  }

  const nowMs = now();
  const scopedCacheKey = buildPublicKeyCacheKey(cacheKey, baseUrl);
  const cached = publicKeyCache.get(scopedCacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.value;
  }
  if (cached) {
    publicKeyCache.delete(scopedCacheKey);
  }

  let accessToken: string;
  let response: Response;
  try {
    accessToken = await getAccessToken(fetchImpl);
    response = await fetchImpl(
      `${baseUrl}/commerce/notification/v1/public_key/${encodeURIComponent(cacheKey)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );
  } catch (error) {
    throw new EbayDeletionNotificationError(
      "public_key_lookup_failed",
      error instanceof Error ? error.message : "Could not fetch the eBay notification public key.",
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new EbayDeletionNotificationError(
      "public_key_lookup_failed",
      `eBay public key lookup failed (${response.status}): ${text}`,
    );
  }

  const payload = (await response.json()) as Partial<EbayNotificationPublicKey>;
  const publicKey = {
    algorithm: normalizeText(payload.algorithm),
    digest: normalizeText(payload.digest),
    key: normalizeText(payload.key),
  };
  if (!publicKey.algorithm || !publicKey.digest || !publicKey.key) {
    throw new EbayDeletionNotificationError(
      "malformed_public_key",
      "eBay public key lookup returned an incomplete key payload.",
    );
  }

  prunePublicKeyCache(nowMs);
  publicKeyCache.set(scopedCacheKey, {
    value: publicKey,
    expiresAt: nowMs + EBAY_NOTIFICATION_PUBLIC_KEY_CACHE_TTL_MS,
    cachedAt: nowMs,
  });

  return publicKey;
}

function normalizeVerificationLabel(value: string): string {
  return value.replace(/[\s_-]+/g, "").toUpperCase();
}

export function verifyEbayDeletionNotificationSignature({
  rawBody,
  signatureHeader,
  loadPublicKey = loadEbayNotificationPublicKey,
}: {
  rawBody: Buffer;
  signatureHeader: string;
  loadPublicKey?: (keyId: string) => Promise<EbayNotificationPublicKey>;
}): Promise<EbayVerificationResult> {
  return (async () => {
    const header = parseSignatureHeader(signatureHeader);
    const publicKey = await loadPublicKey(header.kid);

    const normalizedHeaderAlg = normalizeVerificationLabel(header.alg);
    const normalizedHeaderDigest = normalizeVerificationLabel(header.digest);
    const normalizedKeyAlg = normalizeVerificationLabel(publicKey.algorithm);
    const normalizedKeyDigest = normalizeVerificationLabel(publicKey.digest);

    if (
      normalizedHeaderAlg !== SUPPORTED_SIGNATURE_ALGORITHM
      || normalizedHeaderDigest !== SUPPORTED_SIGNATURE_DIGEST
      || normalizedKeyAlg !== SUPPORTED_SIGNATURE_ALGORITHM
      || normalizedKeyDigest !== SUPPORTED_SIGNATURE_DIGEST
      || normalizedHeaderAlg !== normalizedKeyAlg
      || normalizedHeaderDigest !== normalizedKeyDigest
    ) {
      throw new EbayDeletionNotificationError(
        "unsupported_signature",
        "Unsupported eBay notification signature algorithm or digest.",
      );
    }

    let keyObject;
    let signatureBytes;
    try {
      keyObject = createPublicKey({
        key: decodeBase64(publicKey.key, "publicKey.key", "malformed_public_key"),
        format: "der",
        type: "spki",
      });
      signatureBytes = decodeBase64(header.signature, "signature.signature");
    } catch (error) {
      if (error instanceof EbayDeletionNotificationError) {
        throw error;
      }
      throw new EbayDeletionNotificationError(
        "malformed_public_key",
        error instanceof Error ? error.message : "Could not decode the eBay public key.",
      );
    }

    const verified = verifySignature("sha1", rawBody, keyObject, signatureBytes);
    if (!verified) {
      throw new EbayDeletionNotificationError("bad_signature", "eBay notification signature verification failed.");
    }

    return {
      header: {
        alg: normalizedHeaderAlg,
        kid: header.kid,
        digest: normalizedHeaderDigest,
      },
      publicKey: {
        algorithm: normalizedKeyAlg,
        digest: normalizedKeyDigest,
      },
      payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
    };
  })();
}

export function parseEbayDeletionNotificationPayloadValue(
  parsed: unknown,
): EbayDeletionNotificationPayload {
  if (!isRecord(parsed)) {
    throw new EbayDeletionNotificationError("invalid_payload_shape", "Webhook payload must be a JSON object.");
  }

  const metadata = parsed.metadata;
  const notification = parsed.notification;
  if (!isRecord(metadata) || !isRecord(notification)) {
    throw new EbayDeletionNotificationError(
      "invalid_payload_shape",
      "Webhook payload must include metadata and notification objects.",
    );
  }

  const data = notification.data;
  if (!isRecord(data)) {
    throw new EbayDeletionNotificationError(
      "invalid_payload_shape",
      "Webhook payload must include notification.data.",
    );
  }

  const topic = requireString(metadata.topic, "metadata.topic");
  if (topic !== EBAY_DELETION_TOPIC) {
    throw new EbayDeletionNotificationError(
      "invalid_payload_shape",
      `Webhook topic must be ${EBAY_DELETION_TOPIC}.`,
    );
  }

  return {
    metadata: {
      topic,
      schemaVersion: requireString(metadata.schemaVersion, "metadata.schemaVersion"),
    },
    notification: {
      notificationId: requireString(notification.notificationId, "notification.notificationId"),
      eventDate: requireString(notification.eventDate, "notification.eventDate"),
      publishDate: requireString(notification.publishDate, "notification.publishDate"),
      publishAttemptCount: parsePublishAttemptCount(notification.publishAttemptCount),
      data: {
        username: normalizeText(data.username) || null,
        userId: requireString(data.userId, "notification.data.userId"),
        eiasToken: normalizeText(data.eiasToken) || null,
      },
      },
    };
}

export function parseEbayDeletionNotificationPayload(rawBody: Buffer): EbayDeletionNotificationPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new EbayDeletionNotificationError("invalid_json_payload", "Webhook payload must be valid JSON.");
  }

  return parseEbayDeletionNotificationPayloadValue(parsed);
}

export function buildEbayDeletionReceiptRow({
  payload,
  verification,
}: PersistReceiptInput): Record<string, unknown> {
  return {
    notification_id: payload.notification.notificationId,
    topic: payload.metadata.topic,
    schema_version: payload.metadata.schemaVersion,
    event_date: payload.notification.eventDate,
    publish_date: payload.notification.publishDate,
    publish_attempt_count: payload.notification.publishAttemptCount,
    payload,
    payload_sha256: verification.payloadSha256,
    signature_alg: verification.header.alg,
    signature_digest: verification.header.digest,
    signature_kid: verification.header.kid,
    verification_key_alg: verification.publicKey.algorithm,
    verification_key_digest: verification.publicKey.digest,
    processing_status: "received",
  };
}

function rejectionResponse(status: number, error: string, retryAfterMs?: number): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfterMs != null) {
    headers.set("Retry-After", String(retryAfterSeconds(retryAfterMs)));
  }
  return new Response(JSON.stringify({ received: false, error }), { status, headers });
}

function failureLogFields(
  ipHash: string | null,
  userAgent: string,
  requestStartedAtMs: number,
  now: () => number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    surface: "ebay_deletion_notification",
    route: "/api/ebay/deletion-notification",
    access: "webhook",
    ipHash,
    hasUserAgent: userAgent.length > 0,
    requestMs: now() - requestStartedAtMs,
    ...extra,
  };
}

export async function handleEbayDeletionNotification(
  req: Request,
  {
    now = () => Date.now(),
    rateLimit = webhookRateLimiter,
    logEvent = logPublicWriteEvent,
    verifyNotification = verifyEbayDeletionNotificationSignature,
    persistReceipt,
  }: HandleEbayDeletionNotificationDependencies,
): Promise<Response> {
  const requestStartedAtMs = now();
  const ip = getPublicWriteIp(req);
  const ipHash = hashPublicWriteValue(ip);
  const userAgent = normalizeText(req.headers.get("user-agent"));

  const webhookRate = rateLimit(ip);
  if (!webhookRate.allowed) {
    logEvent("warn", failureLogFields(ipHash, userAgent, requestStartedAtMs, now, {
      outcome: "throttled",
      reason: "ip_burst",
      retryAfterSec: retryAfterSeconds(webhookRate.retryAfterMs),
    }));
    return rejectionResponse(429, "Too many deletion notification attempts.", webhookRate.retryAfterMs);
  }

  const signatureHeader = normalizeText(req.headers.get(EBAY_NOTIFICATION_SIGNATURE_HEADER));
  if (!signatureHeader) {
    logEvent("warn", failureLogFields(ipHash, userAgent, requestStartedAtMs, now, {
      outcome: "rejected_missing_headers",
      reason: "missing_signature_header",
    }));
    return rejectionResponse(400, `Missing ${EBAY_NOTIFICATION_SIGNATURE_HEADER.toUpperCase()} header.`);
  }

  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(await req.arrayBuffer());
  } catch (error) {
    logEvent("warn", failureLogFields(ipHash, userAgent, requestStartedAtMs, now, {
      outcome: "rejected_malformed",
      reason: "unreadable_body",
      error: error instanceof Error ? error.message : String(error),
    }));
    return rejectionResponse(400, "Invalid request body.");
  }

  try {
    const verification = await verifyNotification({ rawBody, signatureHeader });
    const payload = parseEbayDeletionNotificationPayload(rawBody);
    const receipt = await persistReceipt({ payload, verification });
    const subjectHash = hashPublicWriteValue(payload.notification.data.userId);

    logEvent("info", failureLogFields(ipHash, userAgent, requestStartedAtMs, now, {
      outcome: receipt.stored ? "accepted_verified" : "accepted_verified_duplicate",
      notificationIdHash: hashPublicWriteValue(payload.notification.notificationId),
      subjectHash,
      topic: payload.metadata.topic,
      publishAttemptCount: payload.notification.publishAttemptCount,
      signatureKid: verification.header.kid,
      signatureAlg: verification.header.alg,
      signatureDigest: verification.header.digest,
      payloadHash: verification.payloadSha256.slice(0, 16),
      receiptStored: receipt.stored,
    }));

    return Response.json({ received: true });
  } catch (error) {
    const failure = normalizeEbayDeletionNotificationError(error);
    const level = failure.status >= 500 ? "error" : "warn";
    const signatureContext = failure.signatureContext ?? {};

    logEvent(level, failureLogFields(ipHash, userAgent, requestStartedAtMs, now, {
      outcome: failure.outcome,
      reason: failure.reason,
      status: failure.status,
      ...signatureContext,
    }));

    return rejectionResponse(failure.status, failure.publicMessage);
  }
}

function normalizeEbayDeletionNotificationError(error: unknown): {
  outcome: "rejected_malformed" | "rejected_bad_signature" | "error";
  reason: string;
  publicMessage: string;
  status: number;
  signatureContext?: Record<string, unknown>;
} {
  if (!(error instanceof EbayDeletionNotificationError)) {
    return {
      outcome: "error",
      reason: error instanceof Error ? error.message : String(error),
      publicMessage: "Could not process the deletion notification.",
      status: 500,
    };
  }

  switch (error.kind) {
    case "malformed_signature_header":
      return {
        outcome: "rejected_malformed",
        reason: error.kind,
        publicMessage: "Malformed signature header.",
        status: 400,
      };
    case "invalid_json_payload":
    case "invalid_payload_shape":
      return {
        outcome: "rejected_malformed",
        reason: error.kind,
        publicMessage: "Malformed deletion notification payload.",
        status: 400,
      };
    case "unsupported_signature":
    case "bad_signature":
    case "malformed_public_key":
      return {
        outcome: "rejected_bad_signature",
        reason: error.kind,
        publicMessage: "Could not verify the deletion notification signature.",
        status: 412,
      };
    case "public_key_lookup_failed":
      return {
        outcome: "error",
        reason: error.kind,
        publicMessage: "Could not verify the deletion notification signature.",
        status: 503,
      };
    default:
      return {
        outcome: "error",
        reason: error.kind,
        publicMessage: "Could not process the deletion notification.",
        status: 500,
      };
  }
}

export class EbayDeletionNotificationError extends Error {
  kind:
    | "bad_signature"
    | "invalid_json_payload"
    | "invalid_payload_shape"
    | "malformed_public_key"
    | "malformed_signature_header"
    | "public_key_lookup_failed"
    | "unsupported_signature";

  constructor(
    kind:
      | "bad_signature"
      | "invalid_json_payload"
      | "invalid_payload_shape"
      | "malformed_public_key"
      | "malformed_signature_header"
      | "public_key_lookup_failed"
      | "unsupported_signature",
    message: string,
  ) {
    super(message);
    this.kind = kind;
  }
}
