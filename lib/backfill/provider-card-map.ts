import { dbAdmin } from "@/lib/db/admin";

export type ProviderCardMapAssetType = "single" | "sealed";
export type ProviderCardMapStatus = "MATCHED" | "UNMATCHED";
export type ProviderCardMapSource =
  | "PIPELINE"
  | "OBSERVATION_MATCH"
  | "LEGACY_CARD_EXTERNAL_MAPPING"
  | "MANUAL";

export type ProviderCardMapRow = {
  provider: string;
  provider_key: string;
  asset_type: ProviderCardMapAssetType;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  mapping_status: ProviderCardMapStatus;
  match_type: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  mapping_source: string;
  metadata: Record<string, unknown> | null;
  last_observed_at: string | null;
  last_matched_at: string | null;
  last_seen_at: string | null;
  updated_at: string | null;
};

export type ProviderCardMapUpsertRow = {
  provider: string;
  provider_key: string;
  asset_type: ProviderCardMapAssetType;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  mapping_status: ProviderCardMapStatus;
  match_type: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  mapping_source: ProviderCardMapSource;
  metadata: Record<string, unknown>;
  last_seen_at: string;
  last_observed_at: string | null;
  last_matched_at: string | null;
  updated_at: string;
};

function rowPriority(row: ProviderCardMapUpsertRow): number {
  return row.mapping_status === "MATCHED" ? 1 : 0;
}

function compareIso(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = String(left ?? "");
  const rightValue = String(right ?? "");
  return leftValue.localeCompare(rightValue);
}

export function buildProviderCardMapKey(providerCardId: string, providerVariantId: string): string {
  const normalizedCardId = String(providerCardId ?? "").trim();
  const normalizedVariantId = String(providerVariantId ?? "").trim();
  if (!normalizedCardId) throw new Error("providerCardId is required");
  if (!normalizedVariantId) throw new Error("providerVariantId is required");
  return `${normalizedCardId}::${normalizedVariantId}`;
}

export function buildProviderCardMapUpsertRow(input: {
  provider: string;
  assetType: ProviderCardMapAssetType;
  providerSetId?: string | null;
  providerCardId: string;
  providerVariantId: string;
  canonicalSlug?: string | null;
  printingId?: string | null;
  mappingStatus: ProviderCardMapStatus;
  matchType?: string | null;
  matchConfidence?: number | null;
  matchReason?: string | null;
  mappingSource: ProviderCardMapSource;
  metadata?: Record<string, unknown>;
  observedAt?: string | null;
  matchedAt?: string | null;
  updatedAt?: string | null;
}): ProviderCardMapUpsertRow {
  const provider = String(input.provider ?? "").trim().toUpperCase();
  const providerCardId = String(input.providerCardId ?? "").trim();
  const providerVariantId = String(input.providerVariantId ?? "").trim();
  if (!provider) throw new Error("provider is required");
  if (!providerCardId) throw new Error("providerCardId is required");
  if (!providerVariantId) throw new Error("providerVariantId is required");

  const nowIso = input.updatedAt ?? new Date().toISOString();
  const lastObservedAt = input.observedAt ?? null;
  const lastSeenAt = lastObservedAt ?? nowIso;
  const lastMatchedAt = input.mappingStatus === "MATCHED"
    ? (input.matchedAt ?? nowIso)
    : null;

  return {
    provider,
    provider_key: buildProviderCardMapKey(providerCardId, providerVariantId),
    asset_type: input.assetType,
    provider_set_id: input.providerSetId ?? null,
    provider_card_id: providerCardId,
    provider_variant_id: providerVariantId,
    canonical_slug: input.canonicalSlug ?? null,
    printing_id: input.printingId ?? null,
    mapping_status: input.mappingStatus,
    match_type: input.matchType ?? null,
    match_confidence: input.matchConfidence ?? null,
    match_reason: input.matchReason ?? null,
    mapping_source: input.mappingSource,
    metadata: input.metadata ?? {},
    last_seen_at: lastSeenAt,
    last_observed_at: lastObservedAt,
    last_matched_at: lastMatchedAt,
    updated_at: nowIso,
  };
}

export function dedupeProviderCardMapUpsertRows(rows: ProviderCardMapUpsertRow[]): ProviderCardMapUpsertRow[] {
  const byKey = new Map<string, ProviderCardMapUpsertRow>();

  for (const row of rows) {
    const dedupeKey = `${row.provider}::${row.provider_key}`;
    const existing = byKey.get(dedupeKey) ?? null;
    if (!existing) {
      byKey.set(dedupeKey, row);
      continue;
    }

    const replace =
      rowPriority(row) > rowPriority(existing)
      || (
        rowPriority(row) === rowPriority(existing)
        && compareIso(row.updated_at, existing.updated_at) > 0
      )
      || (
        rowPriority(row) === rowPriority(existing)
        && compareIso(row.updated_at, existing.updated_at) === 0
        && compareIso(row.last_observed_at, existing.last_observed_at) > 0
      )
      || (
        rowPriority(row) === rowPriority(existing)
        && compareIso(row.updated_at, existing.updated_at) === 0
        && compareIso(row.last_observed_at, existing.last_observed_at) === 0
        && (row.match_confidence ?? -1) > (existing.match_confidence ?? -1)
      );

    if (replace) {
      byKey.set(dedupeKey, row);
    }
  }

  return [...byKey.values()];
}

export async function loadProviderCardMapByKeys(params: {
  provider: string;
  providerKeys: string[];
}): Promise<Map<string, ProviderCardMapRow>> {
  const provider = String(params.provider ?? "").trim().toUpperCase();
  const providerKeys = Array.from(new Set(
    (params.providerKeys ?? [])
      .map((value) => String(value ?? "").trim())
      .filter((value) => value.length > 0),
  ));
  if (!provider || providerKeys.length === 0) return new Map();

  const supabase = dbAdmin();
  const rows: ProviderCardMapRow[] = [];
  const pageSize = 500;

  for (let i = 0; i < providerKeys.length; i += pageSize) {
    const chunk = providerKeys.slice(i, i + pageSize);
    const { data, error } = await supabase
      .from("provider_card_map")
      .select([
        "provider",
        "provider_key",
        "asset_type",
        "provider_set_id",
        "provider_card_id",
        "provider_variant_id",
        "canonical_slug",
        "printing_id",
        "mapping_status",
        "match_type",
        "match_confidence",
        "match_reason",
        "mapping_source",
        "metadata",
        "last_observed_at",
        "last_matched_at",
        "last_seen_at",
        "updated_at",
      ].join(", "))
      .eq("provider", provider)
      .in("provider_key", chunk);

    if (error) {
      throw new Error(`provider_card_map(load): ${error.message}`);
    }

    rows.push(...((data ?? []) as unknown as ProviderCardMapRow[]));
  }

  const byKey = new Map<string, ProviderCardMapRow>();
  for (const row of rows) {
    byKey.set(row.provider_key, row);
  }
  return byKey;
}
