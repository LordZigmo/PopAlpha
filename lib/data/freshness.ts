import { dbPublic } from "@/lib/db";

export type CanonicalRawFreshnessMonitor = {
  windowHours: number;
  asOf: string;
  cutoffIso: string;
  totalCanonicalRaw: number;
  freshCanonicalRaw: number;
  freshPct: number;
};

export async function getCanonicalRawFreshnessMonitor(windowHours = 24): Promise<CanonicalRawFreshnessMonitor> {
  const supabase = dbPublic();
  const asOf = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const [totalResult, freshResult] = await Promise.all([
    supabase
      .from("public_card_metrics")
      .select("canonical_slug", { count: "exact", head: true })
      .eq("grade", "RAW")
      .is("printing_id", null),
    supabase
      .from("public_card_metrics")
      .select("canonical_slug", { count: "exact", head: true })
      .eq("grade", "RAW")
      .is("printing_id", null)
      .gte("market_price_as_of", cutoffIso),
  ]);

  if (totalResult.error) {
    throw new Error(`freshness(total): ${totalResult.error.message}`);
  }
  if (freshResult.error) {
    throw new Error(`freshness(fresh): ${freshResult.error.message}`);
  }

  const totalCanonicalRaw = totalResult.count ?? 0;
  const freshCanonicalRaw = freshResult.count ?? 0;
  const freshPct = totalCanonicalRaw > 0
    ? Number(((freshCanonicalRaw / totalCanonicalRaw) * 100).toFixed(2))
    : 0;

  return {
    windowHours,
    asOf,
    cutoffIso,
    totalCanonicalRaw,
    freshCanonicalRaw,
    freshPct,
  };
}

