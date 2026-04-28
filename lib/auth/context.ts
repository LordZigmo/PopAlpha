import { auth } from "@clerk/nextjs/server";
import { resolveInternalAdminAllowlist } from "@/lib/auth/internal-admin-session-core";

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthContext =
  | { kind: "public" }
  | { kind: "user"; userId: string; isAdmin?: boolean }
  | { kind: "admin"; reason: string }
  | { kind: "cron"; reason: string };

// ── Timing-safe comparison ───────────────────────────────────────────────────

/**
 * Constant-time string comparison using crypto.timingSafeEqual.
 * Returns false when either value is empty / undefined.
 */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // crypto.timingSafeEqual requires same-length buffers
  try {
    const { timingSafeEqual } = require("crypto") as typeof import("crypto");
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ── User identity via Clerk ─────────────────────────────────────────────────

async function verifyUserJwt(_req: Request): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve the authentication context for an incoming request.
 *
 * Priority:
 * 1. CRON_SECRET bearer → "cron"
 * 2. ADMIN_SECRET bearer / x-admin-secret header / ADMIN_IMPORT_TOKEN bearer → "admin"
 * 3. Clerk session → "user" (with isAdmin: true if userId is in
 *    INTERNAL_ADMIN_CLERK_USER_IDS — same allowlist the internal admin
 *    web UI uses, shared by the iOS app so operators can hit admin API
 *    routes without bundling a shared secret into the client binary).
 *    Admin elevation is a flag on user context, not a replacement, so
 *    user-level routes (/api/me, /api/holdings) keep working for admins.
 * 4. Fallback → "public"
 */
export async function resolveAuthContext(req: Request): Promise<AuthContext> {
  const authHeader = req.headers.get("authorization")?.trim() ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  // 1. Cron secret
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && bearer && safeEqual(bearer, cronSecret)) {
    return { kind: "cron", reason: "bearer-cron-secret" };
  }

  // 2. Admin secret — multiple ways to provide it
  const adminSecret = process.env.ADMIN_SECRET?.trim();
  if (adminSecret) {
    if (bearer && safeEqual(bearer, adminSecret)) {
      return { kind: "admin", reason: "bearer-admin-secret" };
    }
    const headerSecret = req.headers.get("x-admin-secret")?.trim();
    if (headerSecret && safeEqual(headerSecret, adminSecret)) {
      return { kind: "admin", reason: "x-admin-secret-header" };
    }
  }

  const adminImportToken = process.env.ADMIN_IMPORT_TOKEN?.trim();
  if (adminImportToken && bearer && safeEqual(bearer, adminImportToken)) {
    return { kind: "admin", reason: "bearer-admin-import-token" };
  }

  // 3. Clerk user session — preserve the userId so user-level routes
  // (/api/me, /api/holdings, /api/portfolio/*) keep working for the
  // operator. Admin elevation is carried as a *flag* on the user
  // context instead of replacing kind, so admin is a superset of user
  // rather than a sibling. Without this, requireUser() (which only
  // accepts kind === "user") returns 401 for every allowlisted user.
  const userId = await verifyUserJwt(req);
  if (userId) {
    const allowlist = resolveInternalAdminAllowlist();
    const isAdmin = allowlist.clerkUserIds.has(userId);
    return isAdmin
      ? { kind: "user", userId, isAdmin: true }
      : { kind: "user", userId };
  }

  // 4. Fallback
  return { kind: "public" };
}
