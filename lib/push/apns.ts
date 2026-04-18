// APNs (Apple Push Notification service) client.
//
// Sends pushes to iOS devices via HTTP/2 to Apple's push gateway,
// authenticated with an ES256 JWT signed by the `.p8` provider key you
// download from the Apple Developer portal.
//
// Why not a library?
//   - No npm dep in the project (no `jose`, `jsonwebtoken`, `apn`, etc).
//   - Native `crypto` does ES256 out of the box; native `http2` speaks
//     the protocol APNs requires. Net footprint: ~200 lines, zero deps.
//
// Runtime: Node.js only (`http2` + `crypto` are Node primitives).
// Every route that imports this file MUST declare
//   export const runtime = "nodejs";
//
// Environment variables (all required; throws on missing when
// a send is attempted so boot doesn't fail if push isn't yet set up):
//   APNS_KEY_ID       — 10-char Key ID from Developer portal (e.g. "ABC1234567")
//   APNS_TEAM_ID      — 10-char Apple Team ID
//   APNS_KEY_P8       — the contents of AuthKey_{KEY_ID}.p8 (BEGIN/END
//                       PRIVATE KEY lines included). Paste as-is; \n or
//                       literal newlines both work.
//   APNS_BUNDLE_ID    — iOS app bundle id, e.g. "ai.popalpha.ios"
//   APNS_ENVIRONMENT  — "development" (default) or "production"
//                       (only used as the DEFAULT for sends that don't
//                       pass an explicit environment — each row in
//                       apns_device_tokens has its own environment col)

import { createHash, createSign } from "node:crypto";
import * as http2 from "node:http2";

// --- Config ------------------------------------------------------------------

export type ApnsEnvironment = "development" | "production";

interface ApnsConfig {
  keyId: string;
  teamId: string;
  keyP8: string;
  bundleId: string;
  defaultEnvironment: ApnsEnvironment;
}

function getApnsConfig(): ApnsConfig {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const keyP8Raw = process.env.APNS_KEY_P8;
  const bundleId = process.env.APNS_BUNDLE_ID?.trim();
  const env = (process.env.APNS_ENVIRONMENT?.trim() ?? "development") as ApnsEnvironment;

  if (!keyId || !teamId || !keyP8Raw || !bundleId) {
    throw new Error(
      "APNs is not configured. Set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, APNS_BUNDLE_ID.",
    );
  }
  if (env !== "development" && env !== "production") {
    throw new Error(`Invalid APNS_ENVIRONMENT: ${env}. Use "development" or "production".`);
  }

  // Vercel + most env UIs escape newlines as \n in secrets. Normalize
  // so the PEM parser sees real LF characters.
  const keyP8 = keyP8Raw.replace(/\\n/g, "\n");

  return { keyId, teamId, keyP8, bundleId, defaultEnvironment: env };
}

export function isApnsConfigured(): boolean {
  try {
    getApnsConfig();
    return true;
  } catch {
    return false;
  }
}

// --- JWT (ES256) -------------------------------------------------------------

// APNs bearer tokens are valid for up to 60 minutes per Apple's spec;
// in practice you want to rotate before 55m to avoid edge-of-window
// rejection. We cache one JWT per Node process and regenerate on expiry.

let cachedToken: { jwt: string; issuedAt: number } | null = null;
const TOKEN_LIFETIME_SECONDS = 55 * 60;

function getProviderToken(config: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now - cachedToken.issuedAt < TOKEN_LIFETIME_SECONDS) {
    return cachedToken.jwt;
  }

  const header = { alg: "ES256", kid: config.keyId, typ: "JWT" };
  const claims = { iss: config.teamId, iat: now };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // `.sign({ key, dsaEncoding: "ieee-p1363" })` — APNs requires raw
  // r||s (IEEE P-1363) ECDSA signatures, NOT the DER-encoded default
  // that Node produces otherwise. Getting this wrong gives you an
  // opaque "BadDeviceToken" or signature-invalid error from Apple.
  const signature = signer
    .sign({ key: config.keyP8, dsaEncoding: "ieee-p1363" })
    .toString("base64url");

  const jwt = `${signingInput}.${signature}`;
  cachedToken = { jwt, issuedAt: now };
  return jwt;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Exposed for tests / manual rotation during incident response. */
export function clearApnsTokenCache(): void {
  cachedToken = null;
}

// --- HTTP/2 session ----------------------------------------------------------
//
// One long-lived session per host — Apple explicitly encourages reuse.
// We keep two (dev + prod) so the server can fan out to both cohorts
// without reconnect churn.

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};

const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();

function getSession(environment: ApnsEnvironment): http2.ClientHttp2Session {
  const existing = sessions.get(environment);
  if (existing && !existing.destroyed && !existing.closed) return existing;

  const session = http2.connect(APNS_HOSTS[environment]);
  session.on("error", (err) => {
    console.error(`[apns] session error (${environment}):`, err.message);
    sessions.delete(environment);
    session.destroy();
  });
  session.on("close", () => sessions.delete(environment));
  sessions.set(environment, session);
  return session;
}

// --- Payload + send ----------------------------------------------------------

export interface ApnsAlert {
  /** Bold first line of the banner. */
  title: string;
  /** Body copy under the title. */
  body: string;
  /** Optional subtitle between title and body. */
  subtitle?: string;
}

export interface ApnsSendOptions {
  /** Explicit env override. Defaults to the `environment` column on the
   *  device row, which iOS populates from its build configuration. */
  environment?: ApnsEnvironment;
  /** iOS badge count; 0 clears, undefined leaves untouched. */
  badge?: number;
  /** APNs sound file (or "default"). */
  sound?: string;
  /** Thread identifier — groups push notifications in Notification Center. */
  threadId?: string;
  /** Custom data blob bundled into the payload (deep link target, ids, etc). */
  userInfo?: Record<string, unknown>;
  /** true = silent / content-available push (no banner). Suppresses
   *  alert/sound and sets `apns-push-type: background`. */
  contentAvailable?: boolean;
  /** Max delivery attempt TTL. Apple defaults to forever; we default
   *  to 24h so stale notifications (price moves, etc) don't pop days
   *  later when the phone comes back online. */
  expirationSeconds?: number;
  /** APNs priority: 10 (immediate, default for alerts) or 5 (conserve
   *  battery, default for silent pushes). */
  priority?: 5 | 10;
  /** Optional collapse id — Apple coalesces pushes with the same id. */
  collapseId?: string;
}

export interface ApnsSendResult {
  ok: boolean;
  statusCode: number;
  /** Non-ok responses carry an Apple `reason` string we store verbatim. */
  reason?: string;
  /** Apple's unique id for the delivery attempt (apns-id header). */
  apnsId?: string;
}

/**
 * Deliver a push to a single device token.
 *
 * Returns an `ApnsSendResult` describing Apple's response. Caller is
 * responsible for interpreting terminal errors (`BadDeviceToken`,
 * `Unregistered`, `DeviceTokenNotForTopic`) and pruning the row from
 * apns_device_tokens accordingly — see sendApnsToMany() for the
 * convenience helper that does that.
 */
export async function sendApnsToDevice(
  deviceToken: string,
  alert: ApnsAlert | null,
  options: ApnsSendOptions = {},
): Promise<ApnsSendResult> {
  const config = getApnsConfig();
  const environment = options.environment ?? config.defaultEnvironment;
  const session = getSession(environment);
  const jwt = getProviderToken(config);

  // --- Build payload ---------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aps: Record<string, any> = {};
  if (alert) {
    aps.alert = {
      title: alert.title,
      body: alert.body,
      ...(alert.subtitle ? { subtitle: alert.subtitle } : {}),
    };
  }
  if (options.badge !== undefined) aps.badge = options.badge;
  if (options.sound) aps.sound = options.sound;
  if (options.threadId) aps["thread-id"] = options.threadId;
  if (options.contentAvailable) aps["content-available"] = 1;

  const payload = JSON.stringify({
    aps,
    ...(options.userInfo ?? {}),
  });

  // --- Build request headers -------------------------------------------------

  const headers: http2.OutgoingHttpHeaders = {
    ":method": "POST",
    ":path": `/3/device/${deviceToken}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": config.bundleId,
    "apns-push-type": options.contentAvailable ? "background" : "alert",
    "apns-priority": String(options.priority ?? (options.contentAvailable ? 5 : 10)),
    "apns-expiration": String(
      Math.floor(Date.now() / 1000) + (options.expirationSeconds ?? 24 * 60 * 60),
    ),
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    ...(options.collapseId ? { "apns-collapse-id": options.collapseId } : {}),
    // apns-id lets us correlate responses with logs on our side.
    "apns-id": generateApnsId(deviceToken, payload),
  };

  // --- Fire and await response ----------------------------------------------

  return new Promise<ApnsSendResult>((resolve) => {
    const request = session.request(headers);
    let statusCode = 0;
    let apnsId: string | undefined;
    const chunks: Buffer[] = [];

    request.on("response", (responseHeaders) => {
      statusCode = Number(responseHeaders[":status"]) || 0;
      const idHeader = responseHeaders["apns-id"];
      apnsId = Array.isArray(idHeader) ? idHeader[0] : idHeader;
    });

    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (statusCode >= 200 && statusCode < 300) {
        resolve({ ok: true, statusCode, apnsId });
        return;
      }
      // Parse Apple's error shape: { reason: "BadDeviceToken" }
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(body) as { reason?: string };
        reason = parsed.reason;
      } catch {
        reason = body.slice(0, 200) || undefined;
      }
      resolve({ ok: false, statusCode, reason, apnsId });
    });

    request.on("error", (err) => {
      resolve({ ok: false, statusCode: 0, reason: err.message });
    });

    request.end(payload);
  });
}

/**
 * Terminal APNs reason codes that mean the device token is permanently
 * invalid — we should mark the row `enabled = false` (or delete it) so
 * we stop retrying. Transient codes (429 rate limit, 500s) are NOT in
 * this list and the caller should retry those.
 */
export const APNS_TERMINAL_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
  "TopicDisallowed",
  "BadTopic",
]);

/** Stable 32-char uppercase UUID-ish apns-id for correlation. */
function generateApnsId(deviceToken: string, payload: string): string {
  const hash = createHash("sha256")
    .update(deviceToken)
    .update("::")
    .update(payload)
    .update("::")
    .update(String(Date.now()))
    .digest("hex")
    .toUpperCase();
  // Format as 8-4-4-4-12 so Apple's console displays it nicely.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
