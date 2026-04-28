import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers.js";
import { NextResponse } from "next/server.js";
import { redirect } from "next/navigation.js";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import {
  INTERNAL_ADMIN_COOKIE_NAME,
  INTERNAL_ADMIN_DEFAULT_RETURN_TO,
  INTERNAL_ADMIN_SESSION_TTL_MS,
  type InternalAdminAccessDecision,
  type InternalAdminOperatorIdentity,
  type InternalAdminSessionClaims,
  type VerifiedInternalAdminSession,
  buildTrustedInternalAdminOperator,
  createInternalAdminSessionToken,
  evaluateInternalAdminAccess,
  resolveInternalAdminAllowlist,
  resolveInternalAdminSessionSigningSecret,
  sanitizeInternalAdminReturnTo,
  verifyInternalAdminSessionToken,
} from "@/lib/auth/internal-admin-session-core";

export type InternalAdminSession = {
  clerkUserId: string;
  actorIdentifier: string;
  primaryEmail: string | null;
  displayName: string;
  issuedAt: string;
  expiresAt: string;
};

type InternalAdminApiFailureCode =
  | "missing_session"
  | "invalid_session"
  | "unauthenticated"
  | "forbidden"
  | "misconfigured"
  | "session_mismatch";

export type InternalAdminApiAccessResult =
  | {
      ok: true;
      session: InternalAdminSession;
      operator: InternalAdminOperatorIdentity;
    }
  | {
      ok: false;
      response: Response;
      code: InternalAdminApiFailureCode;
    };

// Cookie path scoped to /internal so it covers both
// /internal/admin/* (eBay deletion review) AND sibling internal-
// admin-gated pages like /internal/eval-prelabel without needing
// to broaden to / (which would expose the cookie to public routes).
//
// Originally /internal/admin only — when /internal/eval-prelabel
// was added 2026-04-28 the path mismatch caused an infinite redirect
// loop: browser would not send the cookie to the new page, page
// would redirect back to sign-in, sign-in WOULD see the cookie,
// sign-in would redirect to returnTo, and round it went.
const INTERNAL_ADMIN_COOKIE_PATH = "/internal";

function buildCookieOptions(expiresAtMs: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: INTERNAL_ADMIN_COOKIE_PATH,
    expires: new Date(expiresAtMs),
  };
}

function mapVerifiedSession(
  session: InternalAdminSessionClaims,
  operator: InternalAdminOperatorIdentity,
): InternalAdminSession {
  return {
    clerkUserId: operator.clerkUserId,
    actorIdentifier: operator.actorIdentifier,
    primaryEmail: operator.primaryEmail,
    displayName: operator.displayName,
    issuedAt: new Date(session.issuedAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString(),
  };
}

function signInRedirectHref(returnTo: string): string {
  const normalized = sanitizeInternalAdminReturnTo(returnTo);
  return `/internal/admin/sign-in?returnTo=${encodeURIComponent(normalized)}`;
}

function pathFromReq(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "unknown";
  }
}

function deniedInternalAdminApi(
  req: Request,
  status: number,
  code: InternalAdminApiFailureCode,
  error: string,
): Response {
  console.warn(`[internal-admin] DENIED path=${pathFromReq(req)} code=${code}`);
  return NextResponse.json({ ok: false, error, code }, { status });
}

async function resolveClerkBackedOperator(): Promise<InternalAdminOperatorIdentity | null> {
  if (!clerkEnabled) {
    return null;
  }

  const { userId } = await auth();
  if (!userId) {
    return null;
  }

  const user = await currentUser();
  const fullName = user?.fullName?.trim()
    || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim()
    || user?.username?.trim()
    || null;
  const primaryEmail = user?.primaryEmailAddress?.emailAddress ?? null;

  return buildTrustedInternalAdminOperator({
    clerkUserId: userId,
    primaryEmail,
    displayName: fullName,
  });
}

async function getVerifiedInternalAdminSessionCookie(): Promise<VerifiedInternalAdminSession> {
  const cookieStore = await cookies();
  const token = cookieStore.get(INTERNAL_ADMIN_COOKIE_NAME)?.value;
  return verifyInternalAdminSessionToken(token, {
    secret: resolveInternalAdminSessionSigningSecret(),
  });
}

export async function resolveCurrentInternalAdminAccess(): Promise<InternalAdminAccessDecision> {
  const operator = await resolveClerkBackedOperator();
  return evaluateInternalAdminAccess({
    clerkEnabled,
    operator,
    allowlist: resolveInternalAdminAllowlist(),
  });
}

export async function getCurrentTrustedInternalAdminOperator(): Promise<InternalAdminOperatorIdentity | null> {
  const access = await resolveCurrentInternalAdminAccess();
  return access.kind === "authorized" ? access.operator : null;
}

export async function resolveInternalAdminApiAccess(): Promise<InternalAdminApiAccessResult> {
  const verified = await getVerifiedInternalAdminSessionCookie();
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.code === "missing" ? "missing_session" : "invalid_session",
      response: NextResponse.json(
        { ok: false, error: "Unauthorized", code: verified.code === "missing" ? "missing_session" : "invalid_session" },
        { status: 401 },
      ),
    };
  }

  const access = await resolveCurrentInternalAdminAccess();
  if (access.kind === "misconfigured") {
    return {
      ok: false,
      code: "misconfigured",
      response: NextResponse.json(
        { ok: false, error: "Internal admin auth is misconfigured.", code: "misconfigured", reason: access.reason },
        { status: 503 },
      ),
    };
  }

  if (access.kind === "unauthenticated") {
    return {
      ok: false,
      code: "unauthenticated",
      response: NextResponse.json({ ok: false, error: "Unauthorized", code: "unauthenticated" }, { status: 401 }),
    };
  }

  if (access.kind === "forbidden") {
    return {
      ok: false,
      code: "forbidden",
      response: NextResponse.json({ ok: false, error: "Forbidden", code: "forbidden" }, { status: 403 }),
    };
  }

  if (access.operator.clerkUserId !== verified.session.clerkUserId) {
    return {
      ok: false,
      code: "session_mismatch",
      response: NextResponse.json({ ok: false, error: "Unauthorized", code: "session_mismatch" }, { status: 401 }),
    };
  }

  return {
    ok: true,
    session: mapVerifiedSession(verified.session, access.operator),
    operator: access.operator,
  };
}

export async function getInternalAdminSession(): Promise<InternalAdminSession | null> {
  const access = await resolveInternalAdminApiAccess();
  return access.ok ? access.session : null;
}

export async function requireInternalAdminSession(
  returnTo = INTERNAL_ADMIN_DEFAULT_RETURN_TO,
): Promise<InternalAdminSession> {
  const session = await getInternalAdminSession();
  if (session) return session;
  redirect(signInRedirectHref(returnTo));
}

export async function issueInternalAdminSession(
  operator: InternalAdminOperatorIdentity,
): Promise<InternalAdminSession> {
  const secret = resolveInternalAdminSessionSigningSecret();
  const now = Date.now();
  const token = createInternalAdminSessionToken({
    operator,
    secret,
    now,
    ttlMs: INTERNAL_ADMIN_SESSION_TTL_MS,
  });

  const cookieStore = await cookies();
  cookieStore.set(INTERNAL_ADMIN_COOKIE_NAME, token, buildCookieOptions(now + INTERNAL_ADMIN_SESSION_TTL_MS));

  const verified = verifyInternalAdminSessionToken(token, { secret, now });
  if (!verified.ok) {
    throw new Error("Failed to issue internal admin session.");
  }

  return mapVerifiedSession(verified.session, operator);
}

export async function issueInternalAdminSessionForCurrentOperator(): Promise<InternalAdminSession> {
  const access = await resolveCurrentInternalAdminAccess();
  if (access.kind !== "authorized") {
    throw new Error("Only an allowlisted Clerk operator can issue an internal admin session.");
  }

  return issueInternalAdminSession(access.operator);
}

export async function clearInternalAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(INTERNAL_ADMIN_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: INTERNAL_ADMIN_COOKIE_PATH,
    expires: new Date(0),
    maxAge: 0,
  });
}

export async function requireInternalAdminApiAccess(req: Request): Promise<InternalAdminApiAccessResult> {
  const access = await resolveInternalAdminApiAccess();
  if (access.ok) {
    return access;
  }

  if (access.code === "forbidden") {
    return {
      ok: false,
      code: access.code,
      response: deniedInternalAdminApi(req, 403, access.code, "Forbidden"),
    };
  }

  if (access.code === "misconfigured") {
    return {
      ok: false,
      code: access.code,
      response: deniedInternalAdminApi(req, 503, access.code, "Internal admin auth is misconfigured."),
    };
  }

  return {
    ok: false,
    code: access.code,
    response: deniedInternalAdminApi(req, 401, access.code, "Unauthorized"),
  };
}
