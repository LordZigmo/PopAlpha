import { createClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthContext =
  | { kind: "public" }
  | { kind: "user"; userId: string }
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

// ── User JWT verification ────────────────────────────────────────────────────

/**
 * CLERK SWAP POINT: Replace this function body with:
 *   const { userId } = await auth();
 *   return userId ?? null;
 */
async function verifyUserJwt(req: Request): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  // Extract JWT from cookie or Authorization header
  const authHeader = req.headers.get("authorization") ?? "";
  const cookieHeader = req.headers.get("cookie") ?? "";
  let token: string | null = null;

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    // Parse sb-*-auth-token from cookies
    const match = cookieHeader.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        // Supabase stores the token as a JSON-encoded array ["base64token"]
        const decoded = decodeURIComponent(match[1]);
        const parsed = JSON.parse(decoded);
        token = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        token = decodeURIComponent(match[1]);
      }
    }
  }

  if (!token) return null;

  try {
    const client = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve the authentication context for an incoming request.
 *
 * Priority:
 * 1. CRON_SECRET bearer → "cron"
 * 2. ADMIN_SECRET bearer / x-admin-secret header / ADMIN_IMPORT_TOKEN bearer → "admin"
 * 3. Supabase JWT → "user"
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

  // 3. Supabase user JWT
  const userId = await verifyUserJwt(req);
  if (userId) {
    return { kind: "user", userId };
  }

  // 4. Fallback
  return { kind: "public" };
}
