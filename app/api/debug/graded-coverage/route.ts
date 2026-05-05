import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";

const GRADED_BUCKETS = ["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"] as const;
const PROVIDERS = ["PSA", "CGC", "BGS", "TAG"] as const;
type GradedBucket = (typeof GRADED_BUCKETS)[number];
type Provider = (typeof PROVIDERS)[number];

// Operator-facing diagnostic for graded-pricing surfacing coverage.
// Mirrors a fast subset of scripts/report-graded-pricing-coverage.mjs so
// follow-up phases (Phase 1+) can verify they didn't regress coverage.
//
// Big tables (provider_normalized_observations, price_history_points) use
// estimated counts to stay under the Vercel timeout; small tables
// (price_snapshots, card_metrics, variant_metrics, public_variant_metrics,
// psa_certificates, holdings) use exact counts.
//
// The script remains the source of truth for precise numbers — this route
// is for at-a-glance health checks and CI gates between phases.
export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const since30dIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since7dIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Estimated counts on big tables (planner stats — fast).
  const [obsTotal, snapshotEstTotal, priceHistoryGradedEst] = await Promise.all([
    supabase
      .from("provider_normalized_observations")
      .select("*", { count: "estimated", head: true })
      .then((r) => r.count ?? 0),
    supabase
      .from("price_snapshots")
      .select("*", { count: "estimated", head: true })
      .then((r) => r.count ?? 0),
    // Estimated counts ignore filters in PostgREST, but this still gives
    // a fast total of price_history_points; the value below is the table
    // estimate, not specifically graded. We compensate with an exact
    // count on the (small) graded subset using a head:false fallback if
    // that's ever needed; for now the estimate is the cheap signal.
    supabase
      .from("price_history_points")
      .select("*", { count: "estimated", head: true })
      .then((r) => r.count ?? 0),
  ]);

  // Per-bucket exact counts on price_snapshots (small).
  const snapByGrade: Record<string, number> = {};
  await Promise.all(
    ["RAW", ...GRADED_BUCKETS].map(async (g) => {
      const { count } = await supabase
        .from("price_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("grade", g);
      snapByGrade[g] = count ?? 0;
    }),
  );
  const snapGradedTotal = GRADED_BUCKETS.reduce((a, g) => a + (snapByGrade[g] || 0), 0);

  // card_metrics: RAW total + graded total (small table).
  const [cmRawCount, cmGradedCount] = await Promise.all([
    supabase
      .from("card_metrics")
      .select("*", { count: "exact", head: true })
      .eq("grade", "RAW"),
    supabase
      .from("card_metrics")
      .select("*", { count: "exact", head: true })
      .in("grade", GRADED_BUCKETS as unknown as string[]),
  ]);

  // variant_metrics: graded freshness signals.
  const [
    vmRawCount,
    vmGradedCount,
    vmGradedWithPointsCount,
    vmGradedFresh30dCount,
    vmGradedFresh7dCount,
    vmGradedWithSignalCount,
    pvmGradedCount,
    psaCertCount,
    vmPsaCount,
    holdingsRawCount,
    holdingsGradedCount,
    latestGraded,
  ] = await Promise.all([
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .eq("grade", "RAW"),
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW"),
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW")
      .gt("history_points_30d", 0),
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW")
      .gte("provider_as_of_ts", since30dIso),
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW")
      .gte("provider_as_of_ts", since7dIso),
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW")
      .not("signal_trend", "is", null),
    supabase
      .from("public_variant_metrics")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW"),
    supabase
      .from("psa_certificates")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("variant_metrics")
      .select("*", { count: "exact", head: true })
      .eq("provider", "PSA"),
    supabase
      .from("holdings")
      .select("*", { count: "exact", head: true })
      .eq("grade", "RAW"),
    supabase
      .from("holdings")
      .select("*", { count: "exact", head: true })
      .neq("grade", "RAW")
      .not("grade", "is", null),
    supabase
      .from("variant_metrics")
      .select("updated_at, provider_as_of_ts")
      .neq("grade", "RAW")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // variant_metrics provider × bucket matrix (graded only).
  const matrix: Record<Provider, Record<GradedBucket, number>> = {
    PSA: { LE_7: 0, G8: 0, G9: 0, G9_5: 0, G10: 0, G10_PERFECT: 0 },
    CGC: { LE_7: 0, G8: 0, G9: 0, G9_5: 0, G10: 0, G10_PERFECT: 0 },
    BGS: { LE_7: 0, G8: 0, G9: 0, G9_5: 0, G10: 0, G10_PERFECT: 0 },
    TAG: { LE_7: 0, G8: 0, G9: 0, G9_5: 0, G10: 0, G10_PERFECT: 0 },
  };
  await Promise.all(
    PROVIDERS.flatMap((p) =>
      GRADED_BUCKETS.map(async (b) => {
        const { count } = await supabase
          .from("variant_metrics")
          .select("*", { count: "exact", head: true })
          .eq("provider", p)
          .eq("grade", b);
        matrix[p][b] = count ?? 0;
      }),
    ),
  );

  const latestGradedRow = latestGraded.data as
    | { updated_at?: string | null; provider_as_of_ts?: string | null }
    | null;
  const stalenessHours = latestGradedRow?.updated_at
    ? Math.round((Date.now() - new Date(latestGradedRow.updated_at).getTime()) / 36e5)
    : null;

  const vmGradedTotal = vmGradedCount.count ?? 0;
  const vmGradedWithSignal = vmGradedWithSignalCount.count ?? 0;
  const pvmGradedTotal = pvmGradedCount.count ?? 0;
  const psaCert = psaCertCount.count ?? 0;
  const vmPsa = vmPsaCount.count ?? 0;

  const issues: string[] = [];
  if (vmGradedWithSignal === 0 && vmGradedTotal > 0) {
    issues.push(
      "0 graded variant_metrics rows have non-null signal_trend (signals require >=10 history points; graded variants typically have 1-2)",
    );
  }
  if (stalenessHours !== null && stalenessHours > 24 * 14) {
    issues.push(
      `Latest graded variant_metrics updated_at is ${stalenessHours}h old (~${Math.round(stalenessHours / 24)}d) — likely no continuous graded writer running`,
    );
  }
  if (vmGradedTotal !== pvmGradedTotal) {
    issues.push(
      `View-level loss: variant_metrics graded=${vmGradedTotal} but public_variant_metrics graded=${pvmGradedTotal}`,
    );
  }
  if (psaCert === 0 && vmPsa > 0) {
    issues.push(
      `psa_certificates is empty but variant_metrics has ${vmPsa} provider='PSA' rows — PSA cert ingest path appears to never have run`,
    );
  }

  return NextResponse.json({
    checkedAt,
    durationMs: Date.now() - startedAt,
    healthy: issues.length === 0,
    issues,
    ingestion: {
      observationsTotalEstimated: obsTotal,
      snapshotsTotalEstimated: snapshotEstTotal,
      priceHistoryPointsTotalEstimated: priceHistoryGradedEst,
    },
    priceSnapshots: {
      raw: snapByGrade.RAW,
      gradedTotal: snapGradedTotal,
      gradedByBucket: Object.fromEntries(GRADED_BUCKETS.map((g) => [g, snapByGrade[g] || 0])),
    },
    cardMetrics: {
      raw: cmRawCount.count ?? 0,
      graded: cmGradedCount.count ?? 0,
    },
    variantMetrics: {
      raw: vmRawCount.count ?? 0,
      graded: vmGradedTotal,
      gradedWithHistoryPoints: vmGradedWithPointsCount.count ?? 0,
      gradedFreshAsOf30d: vmGradedFresh30dCount.count ?? 0,
      gradedFreshAsOf7d: vmGradedFresh7dCount.count ?? 0,
      gradedWithSignalTrend: vmGradedWithSignal,
      latestGradedUpdatedAt: latestGradedRow?.updated_at ?? null,
      latestGradedProviderAsOfTs: latestGradedRow?.provider_as_of_ts ?? null,
      latestGradedStalenessHours: stalenessHours,
      providerByBucketGraded: matrix,
    },
    publicView: {
      publicVariantMetricsGraded: pvmGradedTotal,
    },
    psaCertPipeline: {
      psaCertificates: psaCert,
      variantMetricsPsaProvider: vmPsa,
    },
    holdings: {
      raw: holdingsRawCount.count ?? 0,
      graded: holdingsGradedCount.count ?? 0,
    },
  });
}
