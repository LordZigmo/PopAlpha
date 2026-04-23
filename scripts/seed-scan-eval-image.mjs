#!/usr/bin/env node
// Seed a single image into the scanner eval corpus (scan_eval_images).
//
// Usage:
//   npm run eval:seed -- \
//     --image ~/Desktop/charizard.jpg \
//     --slug 151-183-charizard-ex \
//     --source user_photo \
//     --language EN \
//     --notes "held by top corners, kitchen lighting"
//
// Flow:
//   1. Read image bytes from --image.
//   2. Reject if file isn't JPEG (cheap magic-byte check so we don't
//      pollute the bucket with HEIC / PNG / misnamed files).
//   3. Verify --slug exists in canonical_cards so typos don't slip in.
//   4. sha256 the bytes. The hash is both the dedupe key and the
//      Storage object name: card-images/scan-eval/<hash>.jpg.
//   5. Upload (upsert=true → idempotent on the same bytes).
//   6. Insert a row into scan_eval_images.
//
// Requires:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (loaded via --env-file)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const IMAGE_BUCKET = "card-images";
const STORAGE_PREFIX = "scan-eval";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const VALID_SOURCES = new Set(["user_photo", "telemetry", "synthetic", "roboflow"]);
const VALID_LANGUAGES = new Set(["EN", "JP"]);

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

function fail(message) {
  console.error(`seed-scan-eval-image: ${message}`);
  process.exit(1);
}

function isJpegMagic(buffer) {
  // JPEG starts with FF D8 FF. We don't care about the exact APPn
  // marker that follows — just reject anything that's obviously not
  // a JPEG so the scanner identify path isn't asked to decode HEIC.
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.image) fail("--image <path> is required");
  if (!args.slug) fail("--slug <canonical_slug> is required");

  const source = typeof args.source === "string" ? args.source : "user_photo";
  if (!VALID_SOURCES.has(source)) {
    fail(`--source must be one of ${[...VALID_SOURCES].join(", ")}`);
  }

  const language = typeof args.language === "string" ? args.language.toUpperCase() : "EN";
  if (!VALID_LANGUAGES.has(language)) {
    fail(`--language must be one of ${[...VALID_LANGUAGES].join(", ")}`);
  }

  const imagePath = path.resolve(args.image);
  if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
    fail(`image not found: ${imagePath}`);
  }

  const bytes = fs.readFileSync(imagePath);
  if (bytes.length === 0) fail("image is empty");
  if (bytes.length > MAX_IMAGE_BYTES) {
    fail(`image is ${bytes.length} bytes; max allowed is ${MAX_IMAGE_BYTES}`);
  }
  if (!isJpegMagic(bytes)) {
    fail(`${imagePath} is not a JPEG (first bytes do not match FF D8 FF). Convert first.`);
  }

  const imageHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const storagePath = `${STORAGE_PREFIX}/${imageHash}.jpg`;

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const slugCheck = await supabase
    .from("canonical_cards")
    .select("slug")
    .eq("slug", args.slug)
    .maybeSingle();
  if (slugCheck.error) fail(`slug lookup failed: ${slugCheck.error.message}`);
  if (!slugCheck.data) {
    fail(`canonical_cards.slug = ${args.slug} not found. Typo?`);
  }

  const uploadResult = await supabase.storage.from(IMAGE_BUCKET).upload(storagePath, bytes, {
    upsert: true,
    contentType: "image/jpeg",
    cacheControl: "31536000, immutable",
  });
  if (uploadResult.error) fail(`storage upload failed: ${uploadResult.error.message}`);

  // On conflict by (image_storage_path UNIQUE) we update the row — the
  // typical case is "I re-seeded the same image with a corrected
  // source or notes". Upsert keeps things idempotent without needing
  // a special delete path.
  const insertResult = await supabase
    .from("scan_eval_images")
    .upsert(
      {
        canonical_slug: args.slug,
        image_storage_path: storagePath,
        image_hash: imageHash,
        image_bytes_size: bytes.length,
        captured_source: source,
        captured_language: language,
        notes: typeof args.notes === "string" ? args.notes : null,
        created_by: typeof args["created-by"] === "string" ? args["created-by"] : null,
      },
      { onConflict: "image_storage_path" },
    )
    .select("id")
    .maybeSingle();
  if (insertResult.error) fail(`insert failed: ${insertResult.error.message}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        id: insertResult.data?.id,
        storage_path: storagePath,
        canonical_slug: args.slug,
        source,
        language,
        bytes: bytes.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("Fatal:", err?.stack ?? err);
  process.exit(1);
});
