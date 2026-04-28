import { createHmac, timingSafeEqual } from "node:crypto";

export const INTERNAL_ADMIN_COOKIE_NAME = "popalpha_internal_admin";
export const INTERNAL_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const INTERNAL_ADMIN_DEFAULT_RETURN_TO = "/internal/admin/ebay-deletion-tasks";

const INTERNAL_ADMIN_SESSION_VERSION = 2;
const INTERNAL_ADMIN_SESSION_PURPOSE = "internal_admin";
const MAX_OPERATOR_LABEL_LENGTH = 160;
const MAX_CLERK_USER_ID_LENGTH = 191;

type InternalAdminSessionPayload = {
  v: number;
  purpose: string;
  clerkUserId: string;
  actorIdentifier: string;
  primaryEmail: string | null;
  displayName: string;
  iat: number;
  exp: number;
};

export type InternalAdminSessionClaims = {
  clerkUserId: string;
  actorIdentifier: string;
  primaryEmail: string | null;
  displayName: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type InternalAdminOperatorIdentity = {
  clerkUserId: string;
  actorIdentifier: string;
  primaryEmail: string | null;
  displayName: string;
};

export type InternalAdminAllowlist = {
  clerkUserIds: Set<string>;
  emails: Set<string>;
};

export type InternalAdminAccessDecision =
  | { kind: "authorized"; operator: InternalAdminOperatorIdentity }
  | { kind: "forbidden"; operator: InternalAdminOperatorIdentity }
  | { kind: "unauthenticated" }
  | { kind: "misconfigured"; reason: "missing_allowlist" | "clerk_unavailable" };

export type VerifiedInternalAdminSession =
  | { ok: true; session: InternalAdminSessionClaims }
  | {
      ok: false;
      code: "missing" | "malformed" | "invalid_payload" | "bad_signature" | "expired";
    };

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function encodePayload(payload: InternalAdminSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signPayloadSegment(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadSegment).digest("base64url");
}

function normalizePlainString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maxLength
    || /[\r\n\t]/.test(normalized)
    || /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function normalizeInternalAdminClerkUserId(value: unknown): string | null {
  const normalized = normalizePlainString(value, MAX_CLERK_USER_ID_LENGTH);
  if (!normalized || /\s/.test(normalized)) return null;
  return normalized;
}

export function normalizeInternalAdminEmail(value: unknown): string | null {
  const normalized = normalizePlainString(value, MAX_OPERATOR_LABEL_LENGTH);
  if (!normalized) return null;
  return normalized.toLowerCase();
}

export function normalizeInternalAdminDisplayName(value: unknown): string | null {
  return normalizePlainString(value, MAX_OPERATOR_LABEL_LENGTH);
}

export function buildInternalAdminActorIdentifier(clerkUserId: string): string {
  return `clerk:${clerkUserId}`;
}

export function normalizeInternalAdminActorIdentifier(value: unknown): string | null {
  const normalized = normalizePlainString(value, MAX_OPERATOR_LABEL_LENGTH);
  if (!normalized || !normalized.startsWith("clerk:") || /\s/.test(normalized)) {
    return null;
  }

  const clerkUserId = normalizeInternalAdminClerkUserId(normalized.slice("clerk:".length));
  if (!clerkUserId) {
    return null;
  }

  return buildInternalAdminActorIdentifier(clerkUserId);
}

export function buildTrustedInternalAdminOperator(input: {
  clerkUserId: string;
  primaryEmail?: string | null;
  displayName?: string | null;
  fallbackName?: string | null;
}): InternalAdminOperatorIdentity {
  const clerkUserId = normalizeInternalAdminClerkUserId(input.clerkUserId);
  if (!clerkUserId) {
    throw new Error("Trusted internal admin operator requires a valid Clerk user id.");
  }

  const primaryEmail = normalizeInternalAdminEmail(input.primaryEmail ?? null);
  const displayName = normalizeInternalAdminDisplayName(input.displayName)
    ?? normalizeInternalAdminDisplayName(input.fallbackName)
    ?? primaryEmail
    ?? clerkUserId;

  return {
    clerkUserId,
    actorIdentifier: buildInternalAdminActorIdentifier(clerkUserId),
    primaryEmail,
    displayName,
  };
}

function decodePayload(value: string): InternalAdminSessionPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as Partial<InternalAdminSessionPayload>;
    if (
      payload.v !== INTERNAL_ADMIN_SESSION_VERSION
      || payload.purpose !== INTERNAL_ADMIN_SESSION_PURPOSE
      || typeof payload.clerkUserId !== "string"
      || typeof payload.actorIdentifier !== "string"
      || typeof payload.displayName !== "string"
      || (payload.primaryEmail !== null && typeof payload.primaryEmail !== "string")
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
    ) {
      return null;
    }

    return {
      v: payload.v,
      purpose: payload.purpose,
      clerkUserId: payload.clerkUserId,
      actorIdentifier: payload.actorIdentifier,
      primaryEmail: payload.primaryEmail ?? null,
      displayName: payload.displayName,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

function parseDelimitedAllowlist(value: string | undefined, normalizer: (value: string) => string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[,\n]/)
      .map((entry) => normalizer(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function resolveInternalAdminAllowlist(
  env?: { INTERNAL_ADMIN_CLERK_USER_IDS?: string; INTERNAL_ADMIN_EMAILS?: string },
): InternalAdminAllowlist {
  const source = env ?? process.env;
  return {
    clerkUserIds: parseDelimitedAllowlist(
      source.INTERNAL_ADMIN_CLERK_USER_IDS,
      (value) => normalizeInternalAdminClerkUserId(value),
    ),
    emails: parseDelimitedAllowlist(
      source.INTERNAL_ADMIN_EMAILS,
      (value) => normalizeInternalAdminEmail(value),
    ),
  };
}

export function hasConfiguredInternalAdminAllowlist(allowlist: InternalAdminAllowlist): boolean {
  return allowlist.clerkUserIds.size > 0 || allowlist.emails.size > 0;
}

export function isTrustedInternalAdminOperator(
  operator: InternalAdminOperatorIdentity,
  allowlist: InternalAdminAllowlist,
): boolean {
  if (allowlist.clerkUserIds.has(operator.clerkUserId)) {
    return true;
  }

  if (operator.primaryEmail && allowlist.emails.has(operator.primaryEmail)) {
    return true;
  }

  return false;
}

export function evaluateInternalAdminAccess(input: {
  clerkEnabled: boolean;
  operator: InternalAdminOperatorIdentity | null;
  allowlist: InternalAdminAllowlist;
}): InternalAdminAccessDecision {
  if (!input.clerkEnabled) {
    return { kind: "misconfigured", reason: "clerk_unavailable" };
  }

  if (!hasConfiguredInternalAdminAllowlist(input.allowlist)) {
    return { kind: "misconfigured", reason: "missing_allowlist" };
  }

  if (!input.operator) {
    return { kind: "unauthenticated" };
  }

  if (!isTrustedInternalAdminOperator(input.operator, input.allowlist)) {
    return { kind: "forbidden", operator: input.operator };
  }

  return { kind: "authorized", operator: input.operator };
}

/**
 * Allowlist of post-sign-in landing paths. Each entry is either a
 * literal path or a path prefix terminated with "/". The original
 * sole entry was "/internal/admin" — any new internal-admin-gated
 * page that lives outside `/internal/admin/*` (e.g. ones that need
 * client-side rendering, which the strict admin guard forbids) must
 * be added here so its returnTo doesn't get clobbered to the
 * default.
 */
const INTERNAL_ADMIN_RETURN_PATH_ALLOWLIST: readonly string[] = [
  "/internal/admin/",
  "/internal/eval-prelabel",
];

function isAllowedReturnPath(pathname: string): boolean {
  for (const entry of INTERNAL_ADMIN_RETURN_PATH_ALLOWLIST) {
    if (entry.endsWith("/")) {
      if (pathname.startsWith(entry) || pathname === entry.slice(0, -1)) {
        return true;
      }
    } else if (pathname === entry || pathname.startsWith(`${entry}/`)) {
      return true;
    }
  }
  return false;
}

export function sanitizeInternalAdminReturnTo(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.startsWith("//") || raw.includes("://")) {
    return INTERNAL_ADMIN_DEFAULT_RETURN_TO;
  }

  try {
    const parsed = new URL(raw, "https://internal.popalpha.local");
    if (!isAllowedReturnPath(parsed.pathname)) {
      return INTERNAL_ADMIN_DEFAULT_RETURN_TO;
    }
    if (parsed.pathname === "/internal/admin/sign-in") {
      return INTERNAL_ADMIN_DEFAULT_RETURN_TO;
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return INTERNAL_ADMIN_DEFAULT_RETURN_TO;
  }
}

export function createInternalAdminSessionToken(input: {
  operator: InternalAdminOperatorIdentity;
  secret: string;
  now?: number;
  ttlMs?: number;
}): string {
  if (!input.secret) {
    throw new Error("Internal admin session requires a signing secret.");
  }

  const operator = buildTrustedInternalAdminOperator(input.operator);
  const issuedAtMs = input.now ?? Date.now();
  const expiresAtMs = issuedAtMs + (input.ttlMs ?? INTERNAL_ADMIN_SESSION_TTL_MS);
  const payload = encodePayload({
    v: INTERNAL_ADMIN_SESSION_VERSION,
    purpose: INTERNAL_ADMIN_SESSION_PURPOSE,
    clerkUserId: operator.clerkUserId,
    actorIdentifier: operator.actorIdentifier,
    primaryEmail: operator.primaryEmail,
    displayName: operator.displayName,
    iat: issuedAtMs,
    exp: expiresAtMs,
  });
  const signature = signPayloadSegment(payload, input.secret);
  return `${payload}.${signature}`;
}

export function verifyInternalAdminSessionToken(
  token: string | null | undefined,
  input: { secret: string; now?: number },
): VerifiedInternalAdminSession {
  if (!token) {
    return { ok: false, code: "missing" };
  }
  if (!input.secret) {
    return { ok: false, code: "bad_signature" };
  }

  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { ok: false, code: "malformed" };
  }

  const [payloadSegment, signatureSegment] = segments;
  const expectedSignature = signPayloadSegment(payloadSegment, input.secret);
  if (!safeEqual(signatureSegment, expectedSignature)) {
    return { ok: false, code: "bad_signature" };
  }

  const payload = decodePayload(payloadSegment);
  if (!payload) {
    return { ok: false, code: "invalid_payload" };
  }

  const operator = buildTrustedInternalAdminOperator({
    clerkUserId: payload.clerkUserId,
    primaryEmail: payload.primaryEmail,
    displayName: payload.displayName,
  });
  if (payload.actorIdentifier !== operator.actorIdentifier || payload.exp <= payload.iat) {
    return { ok: false, code: "invalid_payload" };
  }

  const now = input.now ?? Date.now();
  if (payload.exp <= now) {
    return { ok: false, code: "expired" };
  }

  return {
    ok: true,
    session: {
      clerkUserId: operator.clerkUserId,
      actorIdentifier: operator.actorIdentifier,
      primaryEmail: operator.primaryEmail,
      displayName: operator.displayName,
      issuedAtMs: payload.iat,
      expiresAtMs: payload.exp,
    },
  };
}

export function resolveInternalAdminSessionSigningSecret(
  env?: { INTERNAL_ADMIN_SESSION_SECRET?: string; ADMIN_SECRET?: string },
): string {
  const source = env ?? process.env;
  const explicit = source.INTERNAL_ADMIN_SESSION_SECRET?.trim() ?? "";
  if (explicit) return explicit;
  const adminSecret = source.ADMIN_SECRET?.trim() ?? "";
  if (adminSecret) return adminSecret;
  throw new Error("Internal admin pages require INTERNAL_ADMIN_SESSION_SECRET or ADMIN_SECRET.");
}
