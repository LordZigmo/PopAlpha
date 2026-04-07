import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";

export const runtime = "nodejs";

/**
 * POST /api/activity/notifications/read — mark notifications as read
 * Body: { ids?: number[] } — if ids omitted, marks all unread as read.
 */
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — mark all
  }

  const db = await createServerSupabaseUserClient();

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => typeof id === "number") : null;

  let query = db
    .from("notifications")
    .update({ read: true })
    .eq("recipient_id", auth.userId)
    .eq("read", false);

  if (ids && ids.length > 0) {
    query = query.in("id", ids);
  }

  const { error } = await query;
  if (error) {
    console.error("[activity/notifications/read]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
