import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 500));
  const supabase = getServerSupabaseClient();

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
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
    count: rows.length,
    rows,
  });
}
