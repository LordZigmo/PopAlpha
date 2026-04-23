/**
 * One-shot: drive public.phase3b_remap_batch() until _phase3b_refs is
 * fully processed. Safe to re-run (resumable via remapped_at IS NULL).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("missing env"); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

let batch = 0, totalRows = 0;
while (true) {
  batch++;
  const t0 = Date.now();
  const { data, error } = await supabase.rpc("phase3b_remap_batch", { p_batch_size: 100 });
  if (error) { console.error("error:", error); process.exit(1); }
  const rows = Number(data ?? 0);
  totalRows += rows;
  console.log(`batch ${batch}: ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s (total ${totalRows.toLocaleString()})`);
  if (rows === 0) break;
}
console.log("phase3b remap complete");
