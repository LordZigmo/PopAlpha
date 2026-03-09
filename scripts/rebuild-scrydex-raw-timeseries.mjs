import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PAGE_SIZE = Number.parseInt(process.env.SCRYDEX_REBUILD_PAGE_SIZE ?? "1000", 10);
const MAP_CHUNK_SIZE = 100;

function buildProviderKey(providerCardId, providerVariantId) {
  return `${String(providerCardId ?? "").trim()}::${String(providerVariantId ?? "").trim()}`;
}

function buildProviderRef(providerVariantId) {
  return `scrydex:${String(providerVariantId ?? "").trim()}`;
}

function buildHistoryVariantRef({ printingId, canonicalSlug, providerVariantId }) {
  const variantId = String(providerVariantId ?? "").trim();
  if (!variantId) {
    throw new Error("providerVariantId is required");
  }

  const normalizedPrintingId = String(printingId ?? "").trim();
  if (normalizedPrintingId) {
    return `${normalizedPrintingId}::${variantId}::RAW`;
  }

  const normalizedCanonicalSlug = String(canonicalSlug ?? "").trim();
  if (normalizedCanonicalSlug) {
    return `${normalizedCanonicalSlug}::${variantId}::RAW`;
  }

  return `scrydex:${variantId}::RAW`;
}

function shouldWriteRawForCondition(condition) {
  const normalized = String(condition ?? "").trim().toLowerCase();
  return normalized === "nm" || normalized === "mint";
}

function parseTrendAnchorPoints(metadata) {
  const raw = metadata?.providerTrendAnchorPoints;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item;
      const ts = String(row.ts ?? "").trim();
      const sourceWindow = String(row.sourceWindow ?? "").trim();
      const price = typeof row.price === "number" ? row.price : Number.parseFloat(String(row.price ?? ""));
      if (!ts || !sourceWindow || !Number.isFinite(price) || price <= 0) return null;
      return {
        ts,
        price,
        currency: "USD",
        source_window: sourceWindow,
      };
    })
    .filter(Boolean);
}

async function loadProviderCardMapByKeys(providerKeys) {
  const rows = [];
  for (let i = 0; i < providerKeys.length; i += MAP_CHUNK_SIZE) {
    const chunk = providerKeys.slice(i, i + MAP_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("provider_card_map")
      .select("provider_key, canonical_slug, printing_id, mapping_status")
      .eq("provider", "SCRYDEX")
      .in("provider_key", chunk);
    if (error) throw error;
    rows.push(...(data ?? []));
  }

  const byKey = new Map();
  for (const row of rows) {
    byKey.set(row.provider_key, row);
  }
  return byKey;
}

async function loadObservationBatch(from) {
  const { data: matchRows, error: matchError } = await supabase
    .from("provider_observation_matches")
    .select("provider_normalized_observation_id")
    .eq("provider", "SCRYDEX")
    .eq("match_status", "MATCHED")
    .order("updated_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (matchError) throw matchError;

  if (!matchRows || matchRows.length === 0) {
    return [];
  }

  const ids = matchRows.map((row) => row.provider_normalized_observation_id).filter(Boolean);
  const { data: observations, error: obsError } = await supabase
    .from("provider_normalized_observations")
    .select("id, provider_set_id, provider_card_id, provider_variant_id, asset_type, normalized_condition, observed_price, currency, observed_at, metadata")
    .in("id", ids)
    .eq("provider", "SCRYDEX");
  if (obsError) throw obsError;

  const providerKeys = [...new Set(
    (observations ?? []).map((row) => buildProviderKey(row.provider_card_id, row.provider_variant_id)),
  )];
  const mappingByKey = await loadProviderCardMapByKeys(providerKeys);

  const selected = [];
  for (const observation of observations ?? []) {
    const providerKey = buildProviderKey(observation.provider_card_id, observation.provider_variant_id);
    const mapping = mappingByKey.get(providerKey) ?? null;
    if (!mapping || mapping.mapping_status !== "MATCHED" || !mapping.canonical_slug) continue;
    selected.push({
      observation,
      mapping,
    });
  }

  return selected;
}

async function main() {
  let totalObservations = 0;
  let totalSnapshots = 0;
  let totalHistory = 0;
  let totalSkippedCondition = 0;

  for (let from = 0; ; from += PAGE_SIZE) {
    const batch = await loadObservationBatch(from);
    if (batch.length === 0) break;

    const snapshotRows = [];
    const historyRows = [];

    for (const row of batch) {
      const observation = row.observation;
      if (!shouldWriteRawForCondition(observation.normalized_condition)) {
        totalSkippedCondition += 1;
        continue;
      }
      if (typeof observation.observed_price !== "number" || !Number.isFinite(observation.observed_price) || observation.observed_price <= 0) {
        continue;
      }

      totalObservations += 1;

      const providerRef = buildProviderRef(observation.provider_variant_id);
      const historyVariantRef = buildHistoryVariantRef({
        printingId: row.mapping.printing_id,
        canonicalSlug: row.mapping.canonical_slug,
        providerVariantId: observation.provider_variant_id,
      });

      snapshotRows.push({
        canonical_slug: row.mapping.canonical_slug,
        printing_id: row.mapping.printing_id,
        grade: "RAW",
        price_value: observation.observed_price,
        currency: "USD",
        provider: "SCRYDEX",
        provider_ref: providerRef,
        ingest_id: null,
        observed_at: observation.observed_at,
      });

      historyRows.push({
        canonical_slug: row.mapping.canonical_slug,
        variant_ref: historyVariantRef,
        provider: "SCRYDEX",
        ts: observation.observed_at,
        price: observation.observed_price,
        currency: "USD",
        source_window: "snapshot",
      });

      for (const point of parseTrendAnchorPoints(observation.metadata)) {
        historyRows.push({
          canonical_slug: row.mapping.canonical_slug,
          variant_ref: historyVariantRef,
          provider: "SCRYDEX",
          ts: point.ts,
          price: point.price,
          currency: point.currency,
          source_window: point.source_window,
        });
      }
    }

    const dedupedSnapshots = [...new Map(
      snapshotRows.map((row) => [`${row.provider}|${row.provider_ref}`, row]),
    ).values()];
    const dedupedHistory = [...new Map(
      historyRows.map((row) => [`${row.provider}|${row.variant_ref}|${row.ts}|${row.source_window}`, row]),
    ).values()];

    if (dedupedSnapshots.length > 0) {
      const { error } = await supabase
        .from("price_snapshots")
        .upsert(dedupedSnapshots, { onConflict: "provider,provider_ref" });
      if (error) throw error;
      totalSnapshots += dedupedSnapshots.length;
    }

    if (dedupedHistory.length > 0) {
      const { error } = await supabase
        .from("price_history_points")
        .upsert(dedupedHistory, { onConflict: "provider,variant_ref,ts,source_window" });
      if (error) throw error;
      totalHistory += dedupedHistory.length;
    }

    console.log(JSON.stringify({
      from,
      observationsSeen: batch.length,
      observationsWritten: totalObservations,
      snapshotsWritten: totalSnapshots,
      historyWritten: totalHistory,
      skippedCondition: totalSkippedCondition,
    }));
  }

  console.log(JSON.stringify({
    ok: true,
    observationsWritten: totalObservations,
    snapshotsWritten: totalSnapshots,
    historyWritten: totalHistory,
    skippedCondition: totalSkippedCondition,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
