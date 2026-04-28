#!/usr/bin/env node
// One-shot: walk every scan_eval_images row, download its Storage
// object, and if the bytes are HEIC, convert + resize to JPEG and
// re-upload. Idempotent — already-JPEG objects are skipped.
//
// Usage:
//   npm run scan-eval:convert-heic
//   npm run scan-eval:convert-heic -- --dry-run
//   npm run scan-eval:convert-heic -- --limit 10
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Why this exists: 120 of 277 corpus images were HEIC at the time of
// commit 0d81bc1 (they snuck in before /api/admin/scan-eval/promote
// learned to convert HEIC). With the route fix in place, NEW labels
// can't reintroduce HEIC. This script back-converts the EXISTING
// corpus so re-running `npm run eval:run` works without re-labeling
// anything.
//
// Deletable after a successful run + a clean re-eval verifies. Treat
// as a disposable one-shot like the canonical_slug accent-bug
// cleanup that preceded it.

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import heicConvert from "heic-convert";

const IMAGE_BUCKET = "card-images";
const UPLOAD_MAX_EDGE_PX = 800;

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

function isHeicMagic(buf) {
  if (buf.length < 12) return false;
  if (buf.slice(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = buf.slice(8, 12).toString("ascii");
  return brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1" || brand === "hevc";
}

async function convertOne(supabase, row) {
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).download(row.image_storage_path);
  if (error) return { kind: "download_failed", reason: error.message };
  const buf = Buffer.from(await data.arrayBuffer());
  if (!isHeicMagic(buf)) return { kind: "skipped_not_heic", originalBytes: buf.byteLength };

  // Decode HEIC → JPEG
  const decoded = await heicConvert({
    buffer: buf,
    format: "JPEG",
    quality: 0.92,
  });
  let jpegBytes = Buffer.from(decoded);

  // Resize if oversized — same 800px cap as the route's resizeForUpload
  const meta = await sharp(jpegBytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w > UPLOAD_MAX_EDGE_PX || h > UPLOAD_MAX_EDGE_PX) {
    jpegBytes = await sharp(jpegBytes)
      .resize({
        width: UPLOAD_MAX_EDGE_PX,
        height: UPLOAD_MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  }

  // Overwrite the existing object at the same key. We keep the same
  // storage path (scan_eval_images.image_storage_path) so eval-runner
  // and dataset-export keep working without DB updates.
  const { error: uploadErr } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(row.image_storage_path, jpegBytes, {
      upsert: true,
      contentType: "image/jpeg",
      cacheControl: "31536000, immutable",
    });
  if (uploadErr) return { kind: "upload_failed", reason: uploadErr.message };

  return {
    kind: "converted",
    originalBytes: buf.byteLength,
    finalBytes: jpegBytes.byteLength,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = Boolean(args["dry-run"]);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : null;

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let q = supabase
    .from("scan_eval_images")
    .select("id, canonical_slug, image_storage_path")
    .order("created_at", { ascending: true });
  if (limit) q = q.limit(limit);
  const { data: rows, error } = await q;
  if (error) {
    console.error(`load scan_eval_images: ${error.message}`);
    process.exit(1);
  }
  console.log(`[convert-heic] loaded ${rows.length} rows · dryRun=${dryRun}`);

  const tally = {
    converted: 0,
    skipped_not_heic: 0,
    download_failed: 0,
    upload_failed: 0,
    bytes_saved: 0,
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (dryRun) {
      // Just sniff the magic bytes — no upload
      const { data, error: dlErr } = await supabase.storage.from(IMAGE_BUCKET).download(row.image_storage_path);
      if (dlErr) {
        tally.download_failed += 1;
      } else {
        const buf = Buffer.from(await data.arrayBuffer());
        if (isHeicMagic(buf)) tally.converted += 1;
        else tally.skipped_not_heic += 1;
      }
    } else {
      const result = await convertOne(supabase, row);
      tally[result.kind] = (tally[result.kind] ?? 0) + 1;
      if (result.kind === "converted") {
        tally.bytes_saved += (result.originalBytes - result.finalBytes);
      }
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  ${i + 1}/${rows.length} processed — ${JSON.stringify(tally)}`);
    }
  }

  console.log(`[convert-heic] final tally: ${JSON.stringify(tally, null, 2)}`);
  if (dryRun) {
    console.log(`[convert-heic] dry-run — no uploads. Re-run without --dry-run to apply.`);
  } else {
    console.log(`[convert-heic] done. ${tally.converted} HEIC → JPEG, ${Math.round(tally.bytes_saved / 1024 / 1024)} MB saved.`);
  }
}

main().catch((err) => {
  console.error("[convert-heic] fatal:", err?.stack ?? err);
  process.exit(1);
});
