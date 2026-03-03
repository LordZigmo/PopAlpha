import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 500));
  const supabase = dbAdmin();

  const { data, error } = await supabase
    .from("tracked_assets")
    .select("canonical_slug, printing_id, grade, priority, enabled, created_at")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 3, limit));

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []).filter((row) => row.enabled).slice(0, limit);

  return NextResponse.json({
    ok: true,
    count: rows.length,
    rows,
  });
}
