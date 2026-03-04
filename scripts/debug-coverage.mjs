import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Get ALL provider_set_map entries to understand the ID pattern
const { data: mapped } = await db
  .from("provider_set_map")
  .select("canonical_set_code, canonical_set_name, provider_set_id, confidence")
  .eq("provider", "JUSTTCG")
  .order("canonical_set_code")
  .limit(500);

console.log("=== All JustTCG Mapped Sets ===");
for (const r of mapped ?? []) {
  console.log(`  ${(r.canonical_set_code ?? "?").padEnd(12)} | ${(r.canonical_set_name ?? "null").padEnd(35)} | ${r.provider_set_id.padEnd(55)} | conf=${r.confidence}`);
}
