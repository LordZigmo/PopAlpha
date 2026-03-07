import { dbAdmin } from "@/lib/db/admin";

export type PriorityProvider = "JUSTTCG" | "SCRYDEX";

export type IngestTarget = {
  setCode: string | null;
  setName: string | null;
  providerSetId: string;
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export async function loadHighValueStaleSetPriority(params: {
  provider: PriorityProvider;
  targets: IngestTarget[];
  staleWindowHours?: number;
  maxProviderSetIds?: number;
}): Promise<string[]> {
  const staleWindowHours = Math.max(1, Math.floor(params.staleWindowHours ?? 24));
  const maxProviderSetIds = Math.max(1, Math.floor(params.maxProviderSetIds ?? 120));
  if (params.targets.length === 0) return [];

  const supabase = dbAdmin();
  const { data: metricsRows, error: metricsError } = await supabase
    .from("public_card_metrics")
    .select("canonical_slug, market_price, market_price_as_of, justtcg_price, scrydex_price")
    .eq("grade", "RAW")
    .is("printing_id", null)
    .not("market_price", "is", null)
    .limit(30000);
  if (metricsError) throw new Error(`set-priority(metrics): ${metricsError.message}`);

  const metricRows = (metricsRows ?? []) as Array<{
    canonical_slug: string;
    market_price: number | null;
    market_price_as_of: string | null;
    justtcg_price: number | null;
    scrydex_price: number | null;
  }>;
  const slugs = metricRows
    .map((row) => row.canonical_slug)
    .filter(Boolean);
  if (slugs.length === 0) return [];

  const slugSetName = new Map<string, string>();
  for (let i = 0; i < slugs.length; i += 500) {
    const batch = slugs.slice(i, i + 500);
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, set_name")
      .in("slug", batch);
    if (error) throw new Error(`set-priority(canonical_cards): ${error.message}`);
    for (const row of (data ?? []) as Array<{ slug: string; set_name: string | null }>) {
      if (row.slug && row.set_name) slugSetName.set(row.slug, row.set_name);
    }
  }

  const setBuckets = new Map<string, Array<{
    marketPrice: number;
    marketAsOf: string | null;
    justtcgPrice: number | null;
    scrydexPrice: number | null;
  }>>();
  for (const row of metricRows) {
    const setName = slugSetName.get(row.canonical_slug);
    if (!setName) continue;
    const marketPrice = typeof row.market_price === "number" && Number.isFinite(row.market_price)
      ? row.market_price
      : null;
    if (marketPrice === null || marketPrice <= 0) continue;
    const bucket = setBuckets.get(setName) ?? [];
    bucket.push({
      marketPrice,
      marketAsOf: row.market_price_as_of,
      justtcgPrice: row.justtcg_price,
      scrydexPrice: row.scrydex_price,
    });
    setBuckets.set(setName, bucket);
  }

  const staleCutoffMs = Date.now() - staleWindowHours * 60 * 60 * 1000;
  const setScoreByName = new Map<string, number>();
  for (const [setName, rows] of setBuckets.entries()) {
    const topRows = [...rows]
      .sort((a, b) => b.marketPrice - a.marketPrice)
      .slice(0, 25);
    if (topRows.length === 0) continue;

    let staleTop25 = 0;
    let dualProviderGap = 0;
    let weightedPrice = 0;
    for (const row of topRows) {
      weightedPrice += row.marketPrice;
      const asOfMs = row.marketAsOf ? new Date(row.marketAsOf).getTime() : NaN;
      if (!Number.isFinite(asOfMs) || asOfMs < staleCutoffMs) staleTop25 += 1;
      if (row.justtcgPrice == null || row.scrydexPrice == null) dualProviderGap += 1;
    }

    // Strongly bias stale high-value sets; include dual-provider gaps for freshness convergence.
    const score = staleTop25 * 1000 + dualProviderGap * 250 + weightedPrice;
    if (score > 0) setScoreByName.set(normalizeText(setName), score);
  }

  const targetBySetName = new Map<string, IngestTarget[]>();
  for (const target of params.targets) {
    const key = normalizeText(target.setName);
    if (!key) continue;
    const list = targetBySetName.get(key) ?? [];
    list.push(target);
    targetBySetName.set(key, list);
  }

  const prioritizedTargets = [...setScoreByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([setName]) => targetBySetName.get(setName) ?? [])
    .map((target) => target.providerSetId)
    .filter(Boolean);

  const unique = new Set<string>();
  const output: string[] = [];
  for (const providerSetId of prioritizedTargets) {
    if (unique.has(providerSetId)) continue;
    unique.add(providerSetId);
    output.push(providerSetId);
    if (output.length >= maxProviderSetIds) break;
  }
  return output;
}

export async function loadCoverageGapSetPriority(params: {
  provider: PriorityProvider;
  targets: IngestTarget[];
  maxProviderSetIds?: number;
}): Promise<string[]> {
  const maxProviderSetIds = Math.max(1, Math.floor(params.maxProviderSetIds ?? 120));
  if (params.targets.length === 0) return [];

  const supabase = dbAdmin();
  const providerSetIds = new Set(params.targets.map((target) => target.providerSetId));
  const scored = new Map<string, number>();

  // Missing/low-confidence set mapping gets highest priority.
  const { data: mapRows, error: mapError } = await supabase
    .from("provider_set_map")
    .select("provider_set_id, confidence")
    .eq("provider", params.provider)
    .limit(20000);
  if (mapError) throw new Error(`set-priority(provider_set_map): ${mapError.message}`);
  for (const row of (mapRows ?? []) as Array<{ provider_set_id: string; confidence: number | null }>) {
    if (!providerSetIds.has(row.provider_set_id)) continue;
    const confidence = typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0;
    if (confidence <= 0) scored.set(row.provider_set_id, (scored.get(row.provider_set_id) ?? 0) + 2000);
  }

  // Unmatched observation concentration indicates unresolved matching coverage.
  const { data: unmatchedRows, error: unmatchedError } = await supabase
    .from("provider_observation_matches")
    .select("provider_set_id")
    .eq("provider", params.provider)
    .eq("match_status", "UNMATCHED")
    .limit(20000);
  if (unmatchedError) throw new Error(`set-priority(unmatched): ${unmatchedError.message}`);
  for (const row of (unmatchedRows ?? []) as Array<{ provider_set_id: string | null }>) {
    const setId = row.provider_set_id ?? "";
    if (!setId || !providerSetIds.has(setId)) continue;
    scored.set(setId, (scored.get(setId) ?? 0) + 1);
  }

  const prioritized = [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([setId]) => setId)
    .slice(0, maxProviderSetIds);

  return prioritized;
}
