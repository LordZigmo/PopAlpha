import { dbAdmin } from "@/lib/db/admin";

const JOB = "provider_derived_signals";
const DEFAULT_BATCH_SIZE = process.env.PROVIDER_DERIVED_SIGNALS_BATCH_SIZE
  ? Math.max(1, parseInt(process.env.PROVIDER_DERIVED_SIGNALS_BATCH_SIZE, 10))
  : 100;

export type VariantSignalRefreshKey = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  grade: string;
};

export type ProviderDerivedSignalsResult = {
  ok: boolean;
  job: string;
  provider: string | null;
  startedAt: string;
  endedAt: string;
  keysRequested: number;
  keysDeduped: number;
  signalBatches: number;
  cacheBatches: number;
  signalRowsUpdated: number;
  variantSignalsLatestRows: number;
  firstError: string | null;
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeKey(
  raw: Partial<VariantSignalRefreshKey> | null | undefined,
): VariantSignalRefreshKey | null {
  const canonicalSlug = String(raw?.canonical_slug ?? "").trim();
  const variantRef = String(raw?.variant_ref ?? "").trim();
  const provider = String(raw?.provider ?? "").trim().toUpperCase();
  const grade = String(raw?.grade ?? "RAW").trim().toUpperCase() || "RAW";
  if (!canonicalSlug || !variantRef || !provider || !grade) return null;
  return {
    canonical_slug: canonicalSlug,
    variant_ref: variantRef,
    provider,
    grade,
  };
}

export function dedupeVariantSignalRefreshKeys(
  keys: Array<Partial<VariantSignalRefreshKey> | null | undefined>,
): VariantSignalRefreshKey[] {
  const deduped = new Map<string, VariantSignalRefreshKey>();
  for (const raw of keys) {
    const normalized = normalizeKey(raw);
    if (!normalized) continue;
    deduped.set(
      `${normalized.canonical_slug}::${normalized.variant_ref}::${normalized.provider}::${normalized.grade}`,
      normalized,
    );
  }
  return [...deduped.values()];
}

function parseSignalRowsUpdated(data: unknown): number {
  if (typeof data === "number" && Number.isFinite(data)) return data;
  if (!data || typeof data !== "object") return 0;
  const row = data as { rowsUpdated?: unknown; rows?: unknown };
  if (typeof row.rowsUpdated === "number" && Number.isFinite(row.rowsUpdated)) return row.rowsUpdated;
  if (typeof row.rows === "number" && Number.isFinite(row.rows)) return row.rows;
  return 0;
}

function parseCacheRowsUpdated(data: unknown): number {
  if (typeof data === "number" && Number.isFinite(data)) return data;
  return 0;
}

export async function refreshDerivedSignalsForVariantKeys(opts: {
  keys: Array<Partial<VariantSignalRefreshKey> | null | undefined>;
  provider?: string | null;
  batchSize?: number;
}): Promise<ProviderDerivedSignalsResult> {
  const startedAt = new Date().toISOString();
  const provider = typeof opts.provider === "string" && opts.provider.trim()
    ? opts.provider.trim().toUpperCase()
    : null;
  const keys = dedupeVariantSignalRefreshKeys(opts.keys);
  const batchSize = parsePositiveInt(opts.batchSize, DEFAULT_BATCH_SIZE);

  let signalBatches = 0;
  let cacheBatches = 0;
  let signalRowsUpdated = 0;
  let variantSignalsLatestRows = 0;
  let firstError: string | null = null;

  if (keys.length === 0) {
    return {
      ok: true,
      job: JOB,
      provider,
      startedAt,
      endedAt: new Date().toISOString(),
      keysRequested: 0,
      keysDeduped: 0,
      signalBatches: 0,
      cacheBatches: 0,
      signalRowsUpdated: 0,
      variantSignalsLatestRows: 0,
      firstError: null,
    };
  }

  const supabase = dbAdmin();

  try {
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      signalBatches += 1;
      const { data, error } = await supabase.rpc("refresh_derived_signals_for_variants", { keys: batch });
      if (error) throw new Error(`refresh_derived_signals_for_variants: ${error.message}`);
      signalRowsUpdated += parseSignalRowsUpdated(data);
    }

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      cacheBatches += 1;
      const { data, error } = await supabase.rpc("refresh_variant_signals_latest_for_variants", { keys: batch });
      if (error) throw new Error(`refresh_variant_signals_latest_for_variants: ${error.message}`);
      variantSignalsLatestRows += parseCacheRowsUpdated(data);
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: firstError === null,
    job: JOB,
    provider,
    startedAt,
    endedAt: new Date().toISOString(),
    keysRequested: opts.keys.length,
    keysDeduped: keys.length,
    signalBatches,
    cacheBatches,
    signalRowsUpdated,
    variantSignalsLatestRows,
    firstError,
  };
}
