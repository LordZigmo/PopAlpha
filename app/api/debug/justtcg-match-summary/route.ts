import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type SummaryRow = {
  match_status: "MATCHED" | "UNMATCHED";
  match_reason: string | null;
};

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const provider = (url.searchParams.get("provider")?.trim().toUpperCase() || "JUSTTCG");
  const providerSetId = url.searchParams.get("set")?.trim() || null;
  const assetType = url.searchParams.get("asset")?.trim() || null;

  if (!providerSetId) {
    return NextResponse.json(
      { ok: false, error: "Missing required ?set=providerSetId" },
      { status: 400 },
    );
  }

  const supabase = dbAdmin();

  let observationQuery = supabase
    .from("provider_normalized_observations")
    .select("id", { count: "exact", head: true })
    .eq("provider", provider)
    .eq("provider_set_id", providerSetId);

  let matchQuery = supabase
    .from("provider_observation_matches")
    .select("match_status, match_reason, provider_normalized_observation_id")
    .eq("provider", provider)
    .eq("provider_set_id", providerSetId);

  if (assetType) {
    observationQuery = observationQuery.eq("asset_type", assetType);
    matchQuery = matchQuery.eq("asset_type", assetType);
  }

  const [{ count: observationCount, error: observationError }, { data: matchRows, error: matchError }] = await Promise.all([
    observationQuery,
    matchQuery,
  ]);

  if (observationError) {
    return NextResponse.json({ ok: false, error: observationError.message }, { status: 500 });
  }
  if (matchError) {
    return NextResponse.json({ ok: false, error: matchError.message }, { status: 500 });
  }

  const rows = (matchRows ?? []) as Array<SummaryRow & { provider_normalized_observation_id: string }>;
  let matched = 0;
  let unmatched = 0;
  const unmatchedReasonCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.match_status === "MATCHED") {
      matched += 1;
      continue;
    }
    unmatched += 1;
    const reason = row.match_reason ?? "UNKNOWN";
    unmatchedReasonCounts.set(reason, (unmatchedReasonCounts.get(reason) ?? 0) + 1);
  }

  const topUnmatchedReasons = [...unmatchedReasonCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  return NextResponse.json({
    ok: true,
    provider,
    providerSetId,
    assetType: assetType ?? "any",
    normalizedObservations: observationCount ?? 0,
    matchedRows: matched,
    unmatchedRows: unmatched,
    unmatchedReasonCounts: topUnmatchedReasons,
  });
}
