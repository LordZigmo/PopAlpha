import { dbAdmin } from "@/lib/db/admin";

type Provider = "JUSTTCG" | "SCRYDEX";

type ProviderAudit = {
  provider: Provider;
  totalObservations: number;
  matchedCount: number;
  unmatchedCount: number;
  matchedPct: number;
  missingProviderSetMapCount: number;
  ambiguousCount: number;
  lowConfidenceBlockedCount: number;
  lowConfidenceMatchedCount: number;
  avgMatchConfidence: number | null;
  alerts: string[];
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export async function captureMatchingQualityAudit(windowHours = 24): Promise<{
  ok: boolean;
  capturedAt: string;
  windowHours: number;
  audits: ProviderAudit[];
}> {
  const supabase = dbAdmin();
  const capturedAt = new Date().toISOString();
  const sinceIso = new Date(Date.now() - Math.max(1, windowHours) * 60 * 60 * 1000).toISOString();
  const providers: Provider[] = ["JUSTTCG", "SCRYDEX"];
  const audits: ProviderAudit[] = [];

  for (const provider of providers) {
    const [
      totalRes,
      matchedRes,
      missingMapRes,
      ambiguousRes,
      lowConfidenceBlockedRes,
      lowConfidenceMatchedRes,
      confidenceRes,
    ] = await Promise.all([
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id", { count: "exact", head: true })
        .eq("provider", provider)
        .gte("updated_at", sinceIso),
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id", { count: "exact", head: true })
        .eq("provider", provider)
        .eq("match_status", "MATCHED")
        .gte("updated_at", sinceIso),
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id", { count: "exact", head: true })
        .eq("provider", provider)
        .eq("match_reason", "MISSING_PROVIDER_SET_MAP")
        .gte("updated_at", sinceIso),
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id", { count: "exact", head: true })
        .eq("provider", provider)
        .like("match_reason", "AMBIGUOUS%")
        .gte("updated_at", sinceIso),
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id", { count: "exact", head: true })
        .eq("provider", provider)
        .eq("match_reason", "LOW_CONFIDENCE_MATCH_BLOCKED")
        .gte("updated_at", sinceIso),
      supabase
        .from("provider_observation_matches")
        .select("provider_normalized_observation_id", { count: "exact", head: true })
        .eq("provider", provider)
        .eq("match_status", "MATCHED")
        .lt("match_confidence", 0.9)
        .gte("updated_at", sinceIso),
      supabase
        .from("provider_observation_matches")
        .select("match_confidence")
        .eq("provider", provider)
        .eq("match_status", "MATCHED")
        .gte("updated_at", sinceIso)
        .limit(10000),
    ]);

    const totalObservations = totalRes.count ?? 0;
    const matchedCount = matchedRes.count ?? 0;
    const unmatchedCount = Math.max(0, totalObservations - matchedCount);
    const matchedPct = totalObservations > 0 ? round2((matchedCount / totalObservations) * 100) : 0;
    const missingProviderSetMapCount = missingMapRes.count ?? 0;
    const ambiguousCount = ambiguousRes.count ?? 0;
    const lowConfidenceBlockedCount = lowConfidenceBlockedRes.count ?? 0;
    const lowConfidenceMatchedCount = lowConfidenceMatchedRes.count ?? 0;

    const confidenceValues = (confidenceRes.data ?? [])
      .map((row) => (row as { match_confidence: number | null }).match_confidence)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const avgMatchConfidence = confidenceValues.length > 0
      ? round2(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length)
      : null;

    const alerts: string[] = [];
    if (totalObservations > 0 && matchedPct < 90) alerts.push(`Match rate low (${matchedPct}%).`);
    if (missingProviderSetMapCount > 0) alerts.push(`Missing provider_set_map rows detected (${missingProviderSetMapCount}).`);
    if (ambiguousCount > 0) alerts.push(`Ambiguous match decisions detected (${ambiguousCount}).`);
    if (lowConfidenceMatchedCount > 0) alerts.push(`Matched rows below confidence threshold detected (${lowConfidenceMatchedCount}).`);

    const payload = {
      sinceIso,
      alerts,
      thresholds: {
        minMatchRatePct: 90,
        minConfidence: 0.9,
      },
    };

    const { error: insertError } = await supabase
      .from("matching_quality_audits")
      .insert({
        provider,
        window_hours: Math.max(1, windowHours),
        total_observations: totalObservations,
        matched_count: matchedCount,
        unmatched_count: unmatchedCount,
        matched_pct: matchedPct,
        missing_provider_set_map_count: missingProviderSetMapCount,
        ambiguous_count: ambiguousCount,
        low_confidence_blocked_count: lowConfidenceBlockedCount,
        low_confidence_matched_count: lowConfidenceMatchedCount,
        avg_match_confidence: avgMatchConfidence,
        payload,
      });
    if (insertError) throw new Error(`matching_quality_audits(insert:${provider}): ${insertError.message}`);

    audits.push({
      provider,
      totalObservations,
      matchedCount,
      unmatchedCount,
      matchedPct,
      missingProviderSetMapCount,
      ambiguousCount,
      lowConfidenceBlockedCount,
      lowConfidenceMatchedCount,
      avgMatchConfidence,
      alerts,
    });
  }

  return {
    ok: true,
    capturedAt,
    windowHours: Math.max(1, windowHours),
    audits,
  };
}

