import { NextResponse } from "next/server";
import { resolveAuthContext, type AuthContext } from "./context";

type AuthSuccess<T> = { ok: true; ctx: T };
type AuthFailure = { ok: false; response: NextResponse };

function denied(path: string, required: string, actual: string): NextResponse {
  console.warn(`[auth] DENIED path=${path} required=${required} actual=${actual}`);
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

function pathFromReq(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "unknown";
  }
}

/**
 * Require cron-level access. Accepts kind "cron" or "admin".
 */
export async function requireCron(
  req: Request,
): Promise<AuthSuccess<Extract<AuthContext, { kind: "cron" | "admin" }>> | AuthFailure> {
  const ctx = await resolveAuthContext(req);
  if (ctx.kind === "cron" || ctx.kind === "admin") {
    return { ok: true, ctx: ctx as Extract<AuthContext, { kind: "cron" | "admin" }> };
  }
  return { ok: false, response: denied(pathFromReq(req), "cron", ctx.kind) };
}

/**
 * Require admin-level access. Accepts kind "admin" only.
 */
export async function requireAdmin(
  req: Request,
): Promise<AuthSuccess<Extract<AuthContext, { kind: "admin" }>> | AuthFailure> {
  const ctx = await resolveAuthContext(req);
  if (ctx.kind === "admin") {
    return { ok: true, ctx };
  }
  return { ok: false, response: denied(pathFromReq(req), "admin", ctx.kind) };
}

/**
 * Require authenticated user. Returns the userId on success.
 */
export async function requireUser(
  req: Request,
): Promise<AuthSuccess<Extract<AuthContext, { kind: "user" }>> & { userId: string } | AuthFailure> {
  const ctx = await resolveAuthContext(req);
  if (ctx.kind === "user") {
    return { ok: true, ctx, userId: ctx.userId };
  }
  return { ok: false, response: denied(pathFromReq(req), "user", ctx.kind) };
}

/**
 * Require an authenticated user who has completed onboarding (has a handle).
 * Returns 401 if not authenticated, 403 with "onboarding_required" if no handle.
 */
export async function requireOnboarded(
  req: Request,
): Promise<
  | (AuthSuccess<Extract<AuthContext, { kind: "user" }>> & { userId: string; handle: string })
  | AuthFailure
> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth;

  // Dynamic import keeps the service-role client out of this file's static imports.
  const { getAppUser } = await import("@/lib/data/app-user");
  const appUser = await getAppUser(auth.userId);

  if (!appUser?.handle) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "onboarding_required" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, ctx: auth.ctx, userId: auth.userId, handle: appUser.handle };
}
