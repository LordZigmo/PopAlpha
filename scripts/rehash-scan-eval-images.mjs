#!/usr/bin/env node
// One-shot: re-hash the CURRENT bytes of every scan_eval/<hash>.jpg
// storage object and update scan_eval_images.image_hash to match.
//
// Why this exists: Step A's HEIC→JPEG cleanup
// (scripts/convert-scan-eval-heic.mjs) overwrote the storage objects
// with their decoded JPEG bytes but left scan_eval_images.image_hash
// pointing at the ORIGINAL HEIC bytes hash. The route hashes incoming
// bytes when iOS / the eval harness POSTs them, so
// scan_identify_events.image_hash is the JPEG bytes hash —
// telemetry-time joins between the two tables silently lose the
// 120 originally-HEIC entries.
//
// Symptom: HIGH-precision queries through scan_identify_events
// JOIN scan_eval_images ON image_hash return wrong numbers because
// half the eval rows don't match.
//
// Fix is mechanical: download each storage object's CURRENT bytes,
// SHA-256 them, update scan_eval_images.image_hash. Idempotent —
// if the hash already matches, the UPDATE is a no-op.
//
// Usage:
//   npm run scan-eval:rehash
//   npm run scan-eval:rehash -- --dry-run
//
// Disposable one-shot. Deletable after a clean re-eval verifies the
// joins work end-to-end.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const IMAGE_BUCKET = "card-images";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = Boolean(args["dry-run"]);

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const { data: rows, error } = await supabase
    .from("scan_eval_images")
    .select("id, image_hash, image_storage_path")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`load scan_eval_images: ${error.message}`);
    process.exit(1);
  }

  console.log(`[rehash] ${rows.length} eval images · dryRun=${dryRun}`);

  const tally = {
    matched: 0,
    updated: 0,
    download_failed: 0,
    update_failed: 0,
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    const { data: blob, error: dlErr } = await supabase.storage
      .from(IMAGE_BUCKET)
      .download(row.image_storage_path);
    if (dlErr || !blob) {
      tally.download_failed += 1;
      console.warn(`  download failed for ${row.image_storage_path}: ${dlErr?.message ?? "no blob"}`);
      continue;
    }

    const bytes = Buffer.from(await blob.arrayBuffer());
    const newHash = crypto.createHash("sha256").update(bytes).digest("hex");

    if (newHash === row.image_hash) {
      tally.matched += 1;
    } else if (dryRun) {
      tally.updated += 1; // would be updated
    } else {
      const { error: updErr } = await supabase
        .from("scan_eval_images")
        .update({ image_hash: newHash, image_bytes_size: bytes.byteLength })
        .eq("id", row.id);
      if (updErr) {
        tally.update_failed += 1;
        console.warn(`  update failed for ${row.id}: ${updErr.message}`);
        continue;
      }
      tally.updated += 1;
    }

    if ((i + 1) % 25 === 0) {
      console.log(`  ${i + 1}/${rows.length} processed — ${JSON.stringify(tally)}`);
    }
  }

  console.log(`[rehash] final tally: ${JSON.stringify(tally, null, 2)}`);
  if (dryRun) {
    console.log(`[rehash] dry-run — no rows updated. Re-run without --dry-run to apply.`);
  }
}

main().catch((err) => {
  console.error("[rehash] fatal:", err?.stack ?? err);
  process.exit(1);
});
