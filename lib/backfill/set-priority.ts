import { dbAdmin } from "@/lib/db/admin";
import { buildSetId } from "@/lib/sets/summary-core.mjs";
import type { BackendPipelineProvider } from "@/lib/backfill/provider-registry";

export type PriorityProvider = BackendPipelineProvider;

export type IngestTarget = {
  setCode: string | null;
  setName: string | null;
  providerSetId: string;
};

type RecentSetCoverageState = {
  setCode: string;
  setName: string;
  setId: string;
  year: number | null;
  totalCanonicalSlugSet: Set<string>;
  pricedCanonicalSlugSet: Set<string>;
  freshCanonicalSlugSet: Set<string>;
  mapConfidence: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatusCode: number | null;
  requestsLastRun: number;
  cardsLastRun: number;
  matchedCount: number;
  unmatchedCount: number;
};

const CANONICAL_SET_LOOKUP_BATCH_SIZE = 100;

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function hoursSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / (1000 * 60 * 60));
}

function calcRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
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
  for (let i = 0; i < slugs.length; i += CANONICAL_SET_LOOKUP_BATCH_SIZE) {
    const batch = slugs.slice(i, i + CANONICAL_SET_LOOKUP_BATCH_SIZE);
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

export async function loadRecentSetConsistencyPriority(params: {
  provider: PriorityProvider;
  targets: IngestTarget[];
  yearFrom?: number;
  freshWindowHours?: number;
  maxProviderSetIds?: number;
}): Promise<string[]> {
  const yearFrom = Math.max(1996, Math.floor(params.yearFrom ?? 2024));
  const freshWindowHours = Math.max(1, Math.floor(params.freshWindowHours ?? 24));
  const maxProviderSetIds = Math.max(1, Math.floor(params.maxProviderSetIds ?? 120));
  if (params.targets.length === 0) return [];

  const targetsBySetCode = new Map<string, IngestTarget[]>();
  for (const target of params.targets) {
    const setCode = String(target.setCode ?? "").trim();
    if (!setCode) continue;
    const bucket = targetsBySetCode.get(setCode) ?? [];
    bucket.push(target);
    targetsBySetCode.set(setCode, bucket);
  }
  if (targetsBySetCode.size === 0) return [];

  const supabase = dbAdmin();
  const pageSize = 1000;
  const recentBySetCode = new Map<string, RecentSetCoverageState>();
  const targetSetCodes = [...targetsBySetCode.keys()];

  for (let i = 0; i < targetSetCodes.length; i += 100) {
    const setCodeChunk = targetSetCodes.slice(i, i + 100);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase.rpc("scan_card_printings_for_priority", {
        p_set_codes: setCodeChunk,
        p_year_from: yearFrom,
        p_limit: pageSize,
        p_offset: from,
      });
      if (error) throw new Error(`set-priority(recent card_printings): ${error.message}`);

      const rows = (data ?? []) as Array<{
        set_code: string | null;
        set_name: string | null;
        year: number | null;
        canonical_slug: string | null;
      }>;
      for (const row of rows) {
        const setCode = String(row.set_code ?? "").trim();
        if (!setCode) continue;
        const setName = String(row.set_name ?? "").trim() || setCode;
        const setId = buildSetId(setName) ?? "";
        if (!setId) continue;
        const existing = recentBySetCode.get(setCode) ?? {
          setCode,
          setName,
          setId,
          year: typeof row.year === "number" && Number.isFinite(row.year) ? row.year : null,
          totalCanonicalSlugSet: new Set<string>(),
          pricedCanonicalSlugSet: new Set<string>(),
          freshCanonicalSlugSet: new Set<string>(),
          mapConfidence: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastStatusCode: null,
          requestsLastRun: 0,
          cardsLastRun: 0,
          matchedCount: 0,
          unmatchedCount: 0,
        };
        if (typeof row.year === "number" && Number.isFinite(row.year)) {
          existing.year = existing.year == null ? row.year : Math.max(existing.year, row.year);
        }
        if (row.canonical_slug) existing.totalCanonicalSlugSet.add(row.canonical_slug);
        recentBySetCode.set(setCode, existing);
      }

      if (rows.length < pageSize) break;
    }
  }

  if (recentBySetCode.size === 0) return [];

  const recentTargets = [...recentBySetCode.values()]
    .flatMap((state) => (targetsBySetCode.get(state.setCode) ?? []).map((target) => ({
      providerSetId: target.providerSetId,
      state,
    })));
  const recentProviderSetIds = [...new Set(recentTargets.map((row) => row.providerSetId).filter(Boolean))];
  const recentSetIds = [...new Set(
    [...recentBySetCode.values()]
      .map((state) => state.setId)
      .filter(Boolean),
  )];
  const freshCutoffIso = new Date(Date.now() - (freshWindowHours * 60 * 60 * 1000)).toISOString();

  for (let i = 0; i < recentProviderSetIds.length; i += 200) {
    const providerSetIdChunk = recentProviderSetIds.slice(i, i + 200);
    const [{ data: mapRows, error: mapError }, { data: healthRows, error: healthError }, { data: matchRows, error: matchError }] = await Promise.all([
      supabase
        .from("provider_set_map")
        .select("provider_set_id, canonical_set_code, confidence")
        .eq("provider", params.provider)
        .in("provider_set_id", providerSetIdChunk),
      supabase
        .from("provider_set_health")
        .select("provider_set_id, canonical_set_code, last_attempt_at, last_success_at, last_status_code, requests_last_run, cards_last_run")
        .eq("provider", params.provider)
        .in("provider_set_id", providerSetIdChunk),
      supabase
        .from("provider_observation_matches")
        .select("provider_set_id, match_status")
        .eq("provider", params.provider)
        .in("provider_set_id", providerSetIdChunk),
    ]);
    if (mapError) throw new Error(`set-priority(recent provider_set_map): ${mapError.message}`);
    if (healthError) throw new Error(`set-priority(recent provider_set_health): ${healthError.message}`);
    if (matchError) throw new Error(`set-priority(recent provider_observation_matches): ${matchError.message}`);

    const stateByProviderSetId = new Map<string, RecentSetCoverageState>();
    for (const target of recentTargets) {
      if (providerSetIdChunk.includes(target.providerSetId)) {
        stateByProviderSetId.set(target.providerSetId, target.state);
      }
    }

    for (const row of (mapRows ?? []) as Array<{
      provider_set_id: string;
      canonical_set_code: string | null;
      confidence: number | null;
    }>) {
      const state = stateByProviderSetId.get(row.provider_set_id) ?? null;
      if (!state) continue;
      state.mapConfidence = typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : 0;
    }

    for (const row of (healthRows ?? []) as Array<{
      provider_set_id: string;
      canonical_set_code: string | null;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_status_code: number | null;
      requests_last_run: number | null;
      cards_last_run: number | null;
    }>) {
      const state = stateByProviderSetId.get(row.provider_set_id) ?? null;
      if (!state) continue;
      state.lastAttemptAt = row.last_attempt_at ?? null;
      state.lastSuccessAt = row.last_success_at ?? null;
      state.lastStatusCode = row.last_status_code ?? null;
      state.requestsLastRun = typeof row.requests_last_run === "number" ? row.requests_last_run : 0;
      state.cardsLastRun = typeof row.cards_last_run === "number" ? row.cards_last_run : 0;
    }

    for (const row of (matchRows ?? []) as Array<{
      provider_set_id: string | null;
      match_status: string | null;
    }>) {
      const providerSetId = String(row.provider_set_id ?? "").trim();
      const state = stateByProviderSetId.get(providerSetId) ?? null;
      if (!state) continue;
      if (row.match_status === "MATCHED") state.matchedCount += 1;
      if (row.match_status === "UNMATCHED") state.unmatchedCount += 1;
    }
  }

  const stateBySetId = new Map<string, RecentSetCoverageState>();
  for (const state of recentBySetCode.values()) {
    stateBySetId.set(state.setId, state);
  }
  for (let i = 0; i < recentSetIds.length; i += 200) {
    const setIdChunk = recentSetIds.slice(i, i + 200);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase.rpc("scan_variant_price_latest_for_priority", {
        p_provider: params.provider,
        p_set_ids: setIdChunk,
        p_limit: pageSize,
        p_offset: from,
      });
      if (error) throw new Error(`set-priority(recent variant_price_latest): ${error.message}`);

      const rows = (data ?? []) as Array<{
        set_id: string | null;
        canonical_slug: string | null;
        latest_observed_at: string | null;
      }>;
      for (const row of rows) {
        const setId = String(row.set_id ?? "").trim();
        const canonicalSlug = String(row.canonical_slug ?? "").trim();
        const state = stateBySetId.get(setId) ?? null;
        if (!state || !canonicalSlug) continue;
        state.pricedCanonicalSlugSet.add(canonicalSlug);
        if (row.latest_observed_at && row.latest_observed_at >= freshCutoffIso) {
          state.freshCanonicalSlugSet.add(canonicalSlug);
        }
      }

      if (rows.length < pageSize) break;
    }
  }

  const scored = recentTargets
    .map(({ providerSetId, state }) => {
      const totalCanonicalCards = state.totalCanonicalSlugSet.size;
      const pricedCanonicalCards = state.pricedCanonicalSlugSet.size;
      const freshCanonicalCards = state.freshCanonicalSlugSet.size;
      if (totalCanonicalCards <= 0) {
        return { providerSetId, score: 0 };
      }

      const freshGapCards = Math.max(totalCanonicalCards - freshCanonicalCards, 0);
      const pricedGapCards = Math.max(totalCanonicalCards - pricedCanonicalCards, 0);
      const freshGapRatio = calcRatio(freshGapCards, totalCanonicalCards) ?? 0;
      const pricedGapRatio = calcRatio(pricedGapCards, totalCanonicalCards) ?? 0;
      const recentBoost = state.year != null && state.year >= 2025 ? 1.35 : 1.15;
      const hoursSinceSuccessValue = hoursSince(state.lastSuccessAt);
      const staleBoost = hoursSinceSuccessValue == null
        ? 1.2
        : hoursSinceSuccessValue >= 48
          ? Math.min(1.5, 1 + ((hoursSinceSuccessValue - 48) / 96))
          : hoursSinceSuccessValue >= 24
            ? 1.1
            : 1;
      const matchRate = calcRatio(state.matchedCount, state.matchedCount + state.unmatchedCount);

      let score = 0;
      score += freshGapRatio * 3000;
      score += freshGapCards * 12;
      score += pricedGapRatio * 1200;
      score += pricedGapCards * 4;

      if (freshCanonicalCards === 0 && pricedCanonicalCards > 0) score += 250;
      if (hoursSinceSuccessValue == null) score += 300;
      if ((state.mapConfidence ?? 0) <= 0) score += 200;

      if (matchRate != null && matchRate >= 0.95) score *= 1.1;
      if (matchRate != null && matchRate < 0.75) score *= 0.8;

      // Keep testing unproven recent sets, but avoid letting repeated zero-price
      // fetches consume the whole budget.
      if (pricedCanonicalCards === 0) {
        score *= state.cardsLastRun > 0 ? 0.15 : 0.4;
      }

      score *= recentBoost * staleBoost;
      return { providerSetId, score };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);

  const seen = new Set<string>();
  const output: string[] = [];
  for (const row of scored) {
    if (!row.providerSetId || seen.has(row.providerSetId)) continue;
    seen.add(row.providerSetId);
    output.push(row.providerSetId);
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
