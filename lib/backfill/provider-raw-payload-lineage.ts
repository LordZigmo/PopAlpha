import type { SupabaseClient } from "@supabase/supabase-js";

export async function ensureProviderRawPayloadLineageId(
  supabase: SupabaseClient,
  providerRawPayloadId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_provider_raw_payload_lineage", {
    p_provider_raw_payload_id: providerRawPayloadId,
  });

  if (error) {
    throw new Error(`ensure_provider_raw_payload_lineage: ${error.message}`);
  }

  const lineageId = String(data ?? "").trim();
  if (!lineageId) {
    throw new Error(`ensure_provider_raw_payload_lineage returned an empty lineage id for ${providerRawPayloadId}`);
  }

  return lineageId;
}
