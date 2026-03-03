import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser } from "@/lib/data/app-user";

export const runtime = "nodejs";

/**
 * GET /api/me
 *
 * Returns the current user's app profile (ensures row exists).
 */
export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const user = await ensureAppUser(auth.userId);
  return NextResponse.json({
    ok: true,
    user: {
      clerk_user_id: user.clerk_user_id,
      handle: user.handle,
      onboarded: !!user.onboarding_completed_at,
      created_at: user.created_at,
    },
  });
}
