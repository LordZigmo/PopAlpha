import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { getHomepageData } from "@/lib/data/homepage";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const now = new Date();

  const [
    cooldownResult,
    jobStatsResult,
    recentJobsResult,
    latestSnapshotResult,
    latestMetricsResult,
    freshSnapshotCountResult,
    freshMetricsCountResult,
    pendingRollupsResult,
  ] = await Promise.all([
    // 1. Active provider cooldowns
    supabase
      .from("provider_set_health")
      .select("provider, provider_set_id, last_status_code, last_error, cooldown_until, last_attempt_at, last_success_at, consecutive_429")
      .eq("provider_set_id", "__provider__"),

    // 2. Pipeline job counts by status (last 24h)
    supabase.rpc("pipeline_job_status_counts" as never).then(
      (res) => res,
      () => ({ data: null, error: { message: "rpc not available" } }),
    ),

    // 3. Most recent 10 pipeline jobs
    supabase
      .from("pipeline_jobs")
      .select("id, provider, job_kind, status, attempts, last_error, started_at, finished_at, created_at")
      .order("created_at", { ascending: false })
      .limit(10),

    // 4. Most recent price_snapshot observed_at
    supabase
      .from("price_snapshots")
      .select("observed_at, provider")
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // 5. Most recent card_metrics market_price_as_of
    supabase
      .from("card_metrics")
      .select("market_price_as_of, updated_at")
      .not("market_price_as_of", "is", null)
      .order("market_price_as_of", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // 6. Count of price_snapshots in last 24h
    supabase
      .from("price_snapshots")
      .select("id", { count: "exact", head: true })
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .gte("observed_at", new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()),

    // 7. Count of card_metrics with fresh market_price_as_of (last 72h)
    supabase
      .from("card_metrics")
      .select("id", { count: "exact", head: true })
      .eq("grade", "RAW")
      .is("printing_id", null)
      .not("market_price", "is", null)
      .gte("market_price_as_of", new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString()),

    // 8. Pending rollups count
    supabase
      .from("pending_rollups")
      .select("canonical_slug", { count: "exact", head: true }),
  ]);

  // Derive cooldown status
  const cooldowns = (cooldownResult.data ?? []).map((row: Record<string, unknown>) => {
    const cooldownUntil = row.cooldown_until as string | null;
    const active = cooldownUntil ? new Date(cooldownUntil).getTime() > now.getTime() : false;
    return { ...row, active };
  });

  // Derive freshness
  const latestSnapshotAt = (latestSnapshotResult.data as Record<string, unknown> | null)?.observed_at as string | null;
  const latestMetricsAt = (latestMetricsResult.data as Record<string, unknown> | null)?.market_price_as_of as string | null;
  const snapshotAgeHours = latestSnapshotAt
    ? Number(((now.getTime() - new Date(latestSnapshotAt).getTime()) / (60 * 60 * 1000)).toFixed(1))
    : null;
  const metricsAgeHours = latestMetricsAt
    ? Number(((now.getTime() - new Date(latestMetricsAt).getTime()) / (60 * 60 * 1000)).toFixed(1))
    : null;

  // Build diagnosis
  const issues: string[] = [];
  if (cooldowns.some((c: Record<string, unknown>) => c.active)) {
    issues.push("SCRYDEX credit cap cooldown is ACTIVE — no new jobs will be queued");
  }
  if (snapshotAgeHours !== null && snapshotAgeHours > 24) {
    issues.push(`Latest price_snapshot is ${snapshotAgeHours}h old — pipeline may not be writing`);
  }
  if (snapshotAgeHours === null) {
    issues.push("No SCRYDEX/POKEMON_TCG_API price_snapshots found at all");
  }
  if (metricsAgeHours !== null && metricsAgeHours > 72) {
    issues.push(`Latest card_metrics market_price_as_of is ${metricsAgeHours}h old — homepage will show zero cards`);
  }
  if (metricsAgeHours === null) {
    issues.push("No card_metrics rows have a non-null market_price_as_of");
  }
  if ((freshMetricsCountResult.count ?? 0) === 0) {
    issues.push("Zero card_metrics rows have market_price_as_of within 72h — homepage movers query returns nothing");
  }

  // Diagnose homepage directly
  let homepageDiag: Record<string, unknown> = {};
  try {
    const errors: string[] = [];
    const infos: string[] = [];
    const homepageData = await getHomepageData({
      logger: {
        error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
        info: (...args: unknown[]) => infos.push(args.map(String).join(" ")),
      },
    });
    homepageDiag = {
      ok: true,
      movers: homepageData.movers.length,
      losers: homepageData.losers.length,
      trending: homepageData.trending.length,
      pricesRefreshedToday: homepageData.prices_refreshed_today,
      trackedCardsWithLivePrice: homepageData.tracked_cards_with_live_price,
      asOf: homepageData.as_of,
      errors,
      infos,
    };
  } catch (err) {
    homepageDiag = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json({
    checkedAt: now.toISOString(),
    healthy: issues.length === 0,
    issues,
    cooldowns,
    pipeline: {
      jobStatusCounts: jobStatsResult.data ?? jobStatsResult.error?.message,
      recentJobs: recentJobsResult.data ?? [],
      recentJobsError: recentJobsResult.error?.message ?? null,
    },
    freshness: {
      latestSnapshotAt,
      latestSnapshotProvider: (latestSnapshotResult.data as Record<string, unknown> | null)?.provider ?? null,
      snapshotAgeHours,
      freshSnapshots24h: freshSnapshotCountResult.count ?? 0,
      latestMetricsMarketPriceAsOf: latestMetricsAt,
      metricsAgeHours,
      freshMetrics72h: freshMetricsCountResult.count ?? 0,
    },
    pendingRollups: pendingRollupsResult.count ?? 0,
    homepage: homepageDiag,
  });
}
