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
  const sinceHours = Math.max(1, Math.min(parseInt(url.searchParams.get("since_hours") ?? "24", 10) || 24, 24 * 30));
  const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const supabase = getServerSupabaseClient();

  const { data: diagnostics, error } = await supabase
    .from("tracked_refresh_diagnostics")
    .select("id, run_id, canonical_slug, printing_id, reason, meta, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const printingIds = Array.from(new Set((diagnostics ?? []).map((row) => row.printing_id).filter(Boolean)));
  const [trackedResult, mappingResult] = await Promise.all([
    printingIds.length > 0
      ? supabase
          .from("tracked_assets")
          .select("canonical_slug, printing_id, grade, priority, enabled, created_at")
          .in("printing_id", printingIds)
      : Promise.resolve({ data: [], error: null }),
    printingIds.length > 0
      ? supabase
          .from("card_external_mappings")
          .select("id, canonical_slug, printing_id, external_id, meta, created_at")
          .eq("source", "JUSTTCG")
          .eq("mapping_type", "printing")
          .in("printing_id", printingIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (trackedResult.error) {
    return NextResponse.json({ ok: false, error: trackedResult.error.message }, { status: 500 });
  }
  if (mappingResult.error) {
    return NextResponse.json({ ok: false, error: mappingResult.error.message }, { status: 500 });
  }

  const trackedByPrinting = new Map<string, unknown[]>();
  for (const row of trackedResult.data ?? []) {
    const bucket = trackedByPrinting.get(row.printing_id) ?? [];
    bucket.push(row);
    trackedByPrinting.set(row.printing_id, bucket);
  }

  const mappingsByPrinting = new Map<string, unknown[]>();
  for (const row of mappingResult.data ?? []) {
    const bucket = mappingsByPrinting.get(row.printing_id) ?? [];
    bucket.push(row);
    mappingsByPrinting.set(row.printing_id, bucket);
  }

  const rows = (diagnostics ?? []).map((row) => ({
    ...row,
    tracked_assets: trackedByPrinting.get(row.printing_id) ?? [],
    justtcg_mappings: mappingsByPrinting.get(row.printing_id) ?? [],
  }));

  const { data: latestNightlyRun } = await supabase
    .from("ingest_runs")
    .select("id, started_at, ended_at, status, ok, meta")
    .eq("job", "sync_justtcg_prices_nightly")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
    since_hours: sinceHours,
    count: rows.length,
    latest_nightly_run: latestNightlyRun ?? null,
    rows,
  });
}
