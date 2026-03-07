import { dbAdmin } from "@/lib/db/admin";
import { computeConfidenceBand, type ObservationInput } from "@/lib/pricing/market-confidence";

type HistoryRow = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  ts: string;
  price: number;
};

type DiagnosticInsert = {
  canonical_slug: string;
  variant_ref: string;
  provider: string;
  observed_at: string;
  observed_price: number;
  reason: "MAD" | "IQR";
  context: {
    sampleSize: number;
    excludedPoints: number;
    confidenceScore: number;
  };
};

function normalizeProvider(provider: string | null | undefined): "JUSTTCG" | "SCRYDEX" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "JUSTTCG") return "JUSTTCG";
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
}

export async function captureOutlierDiagnostics(opts?: {
  lookbackHours?: number;
  sampleLimit?: number;
  upsertLimit?: number;
}): Promise<{
  ok: boolean;
  groupsScanned: number;
  excludedPoints: number;
  inserted: number;
}> {
  const lookbackHours = Math.max(1, Math.floor(opts?.lookbackHours ?? 24));
  const sampleLimit = Math.max(500, Math.floor(opts?.sampleLimit ?? 5000));
  const upsertLimit = Math.max(50, Math.floor(opts?.upsertLimit ?? 1200));
  const sinceIso = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("public_price_history")
    .select("canonical_slug, variant_ref, provider, ts, price")
    .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
    .eq("source_window", "snapshot")
    .gte("ts", sinceIso)
    .order("ts", { ascending: false })
    .limit(sampleLimit);

  if (error) {
    throw new Error(`outlier_diagnostics(load): ${error.message}`);
  }

  const rows = (data ?? []) as HistoryRow[];
  const byGroup = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    if (!row.canonical_slug || !row.variant_ref || !Number.isFinite(row.price) || row.price <= 0) continue;
    const key = `${row.canonical_slug}||${row.variant_ref}`;
    const bucket = byGroup.get(key) ?? [];
    bucket.push(row);
    byGroup.set(key, bucket);
  }

  const inserts: DiagnosticInsert[] = [];
  for (const [key, group] of byGroup.entries()) {
    if (group.length < 5) continue;
    const observations: ObservationInput[] = group
      .map((row) => {
        const provider = normalizeProvider(row.provider);
        if (!provider) return null;
        return {
          provider,
          ts: row.ts,
          price: row.price,
        };
      })
      .filter((row): row is ObservationInput => Boolean(row));

    if (observations.length < 5) continue;
    const band = computeConfidenceBand({ observations });
    if (band.excluded.length === 0) continue;

    const [canonicalSlug, variantRef] = key.split("||");
    if (!canonicalSlug || !variantRef) continue;

    for (const excluded of band.excluded) {
      inserts.push({
        canonical_slug: canonicalSlug,
        variant_ref: variantRef,
        provider: excluded.provider,
        observed_at: excluded.ts,
        observed_price: excluded.price,
        reason: excluded.reason,
        context: {
          sampleSize: band.sampleSize,
          excludedPoints: band.excludedPoints,
          confidenceScore: band.confidenceScore,
        },
      });
      if (inserts.length >= upsertLimit) break;
    }
    if (inserts.length >= upsertLimit) break;
  }

  if (inserts.length === 0) {
    return {
      ok: true,
      groupsScanned: byGroup.size,
      excludedPoints: 0,
      inserted: 0,
    };
  }

  const { error: writeError, count } = await supabase
    .from("outlier_excluded_points")
    .upsert(inserts, {
      onConflict: "canonical_slug,variant_ref,provider,observed_at,reason",
      ignoreDuplicates: false,
      count: "exact",
    });

  if (writeError) {
    throw new Error(`outlier_diagnostics(upsert): ${writeError.message}`);
  }

  return {
    ok: true,
    groupsScanned: byGroup.size,
    excludedPoints: inserts.length,
    inserted: count ?? inserts.length,
  };
}
