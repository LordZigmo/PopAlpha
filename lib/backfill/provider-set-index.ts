import { dbAdmin } from "@/lib/db/admin";
import type { BackendPipelineProvider } from "@/lib/backfill/provider-registry";

export type ProviderSetIndexRow = {
  canonicalSetCode: string;
  canonicalSetName: string | null;
  providerSetId: string;
  confidence: number;
};

type ProviderSetMapRow = {
  canonical_set_code: string;
  canonical_set_name: string | null;
  provider_set_id: string;
  confidence: number | null;
};

export async function loadProviderSetIndex(provider: BackendPipelineProvider): Promise<ProviderSetIndexRow[]> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, canonical_set_name, provider_set_id, confidence")
    .eq("provider", provider)
    .gt("confidence", 0)
    .order("canonical_set_code", { ascending: true });

  if (error) throw new Error(`provider_set_map(index): ${error.message}`);

  const rows = (data ?? []) as ProviderSetMapRow[];
  const deduped = new Map<string, ProviderSetIndexRow>();
  for (const row of rows) {
    const canonicalSetCode = String(row.canonical_set_code ?? "").trim();
    const providerSetId = String(row.provider_set_id ?? "").trim();
    if (!canonicalSetCode || !providerSetId) continue;
    if (deduped.has(canonicalSetCode)) continue;
    deduped.set(canonicalSetCode, {
      canonicalSetCode,
      canonicalSetName: row.canonical_set_name?.trim() || null,
      providerSetId,
      confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : 0,
    });
  }
  return [...deduped.values()];
}
