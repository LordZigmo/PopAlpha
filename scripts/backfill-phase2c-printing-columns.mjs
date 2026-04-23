/**
 * backfill-phase2c-printing-columns.mjs
 *
 * Backfills printing_id / finish / provider_variant_token on
 * public.price_history_points by calling the DB-side batch function
 * public.phase2c_backfill_batch(shape, size) repeatedly until no rows
 * remain for the given shape.
 *
 * Idempotent + resumable — relies on `WHERE printing_id IS NULL` in the
 * function body. Safe to Ctrl+C and re-run.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-phase2c-printing-columns.mjs
 *   node --env-file=.env.local scripts/backfill-phase2c-printing-columns.mjs --shape=canonical
 *   node --env-file=.env.local scripts/backfill-phase2c-printing-columns.mjs --shape=provider_history
 *   node --env-file=.env.local scripts/backfill-phase2c-printing-columns.mjs --batch=50000
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [arg.replace(/^--/, ""), true];
  })
);

const BATCH = Number(args.batch ?? 100000);
const SHAPES = args.shape ? [args.shape] : ["canonical", "provider_history"];

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function runShape(shape) {
  console.log(`\n[${shape}] starting, batch size=${BATCH}`);
  const t0 = Date.now();
  let totalRows = 0;
  let batchNum = 0;
  while (true) {
    batchNum += 1;
    const batchStart = Date.now();
    const { data, error } = await supabase.rpc("phase2c_backfill_batch", {
      p_shape: shape,
      p_batch_size: BATCH,
    });
    if (error) {
      console.error(`[${shape}] batch ${batchNum} error:`, error);
      process.exit(1);
    }
    const rows = Number(data ?? 0);
    totalRows += rows;
    const elapsedSec = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log(`[${shape}] batch ${batchNum}: ${rows} rows in ${elapsedSec}s (total ${totalRows.toLocaleString()})`);
    if (rows === 0) break;
  }
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${shape}] done: ${totalRows.toLocaleString()} rows in ${totalSec}s`);
}

for (const shape of SHAPES) {
  await runShape(shape);
}

console.log("\nphase2c backfill complete.");
