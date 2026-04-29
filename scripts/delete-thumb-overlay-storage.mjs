#!/usr/bin/env node
// One-shot: walk the augmented/ Storage prefix and DELETE every object
// whose name starts with v3- or v4-. Companion to the Neon row cleanup
// at /api/admin/cleanup/delete-thumb-overlay-augs.
//
// Why local: Storage operations are fast over HTTPS and don't need
// Vercel-side env injection. SUPABASE_SERVICE_ROLE_KEY in .env.local
// is sufficient.
//
// Why now: 2026-04-29 we retired recipe-v2 synthetic thumb-overlay
// augmentations. Index 3 (bottom-right) and 4 (top-left) variants are
// gone from AUGMENTATION_VARIANTS, the runtime kNN filter blocks them
// from query results, and the Neon rows are deleted. Storage objects
// at augmented/<slug>/v3-*.jpg and v4-*.jpg are now orphaned bytes —
// this script reclaims that space.
//
// Idempotent: re-runs skip already-deleted objects. Safe to replay.
//
// Usage:
//   npm run scan-eval:delete-thumb-overlay-storage
//   npm run scan-eval:delete-thumb-overlay-storage -- --dry-run
//   npm run scan-eval:delete-thumb-overlay-storage -- --limit 50
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Disposable one-shot: deletable after a successful run + cleanup
// verification, same as scripts/convert-scan-eval-heic.mjs.

import { createClient } from "@supabase/supabase-js";

const IMAGE_BUCKET = "card-images";
const AUGMENTED_PREFIX = "augmented";
const RETIRED_PREFIXES = ["v3-", "v4-"];
const STORAGE_LIST_PAGE = 1000; // Supabase storage list cap is 1000

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

async function listSafeSlugDirs(supabase) {
  // Top-level listing under augmented/ returns one entry per slug
  // directory. Pagination via offset since the bucket may have >1k
  // slugs after past augmentation runs.
  const out = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .list(AUGMENTED_PREFIX, { limit: STORAGE_LIST_PAGE, offset });
    if (error) throw new Error(`list ${AUGMENTED_PREFIX} (offset ${offset}): ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data.map((d) => d.name));
    if (data.length < STORAGE_LIST_PAGE) break;
    offset += data.length;
  }
  return out;
}

async function listRetiredObjectsInSlug(supabase, safeSlug) {
  const { data, error } = await supabase.storage
    .from(IMAGE_BUCKET)
    .list(`${AUGMENTED_PREFIX}/${safeSlug}`, { limit: STORAGE_LIST_PAGE });
  if (error) {
    return { keys: [], err: error.message };
  }
  const keys = (data ?? [])
    .filter((d) => RETIRED_PREFIXES.some((p) => d.name.startsWith(p)))
    .map((d) => `${AUGMENTED_PREFIX}/${safeSlug}/${d.name}`);
  return { keys, err: null };
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = Boolean(args["dry-run"]);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : null;

  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  console.log(`[cleanup] listing slug dirs under ${AUGMENTED_PREFIX}/ ...`);
  const safeSlugs = await listSafeSlugDirs(supabase);
  console.log(`[cleanup] found ${safeSlugs.length} slug dirs · dryRun=${dryRun}`);

  const tally = { listed_keys: 0, deleted: 0, skipped_dry: 0, list_failed: 0, delete_failed: 0 };
  const processedSlugs = limit ?? safeSlugs.length;

  for (let i = 0; i < Math.min(safeSlugs.length, processedSlugs); i += 1) {
    const safeSlug = safeSlugs[i];
    const { keys, err } = await listRetiredObjectsInSlug(supabase, safeSlug);
    if (err) {
      tally.list_failed += 1;
      console.warn(`  list failed for ${safeSlug}: ${err}`);
      continue;
    }
    tally.listed_keys += keys.length;
    if (keys.length === 0) {
      // Skip — common case once cleanup has run once.
    } else if (dryRun) {
      tally.skipped_dry += keys.length;
    } else {
      // Storage remove() accepts an array of keys; do it in one call
      // per slug to bound the request count.
      const { error: rmErr } = await supabase.storage.from(IMAGE_BUCKET).remove(keys);
      if (rmErr) {
        tally.delete_failed += keys.length;
        console.warn(`  delete failed for ${safeSlug} (${keys.length} keys): ${rmErr.message}`);
      } else {
        tally.deleted += keys.length;
      }
    }
    if ((i + 1) % 200 === 0) {
      console.log(`  ${i + 1}/${Math.min(safeSlugs.length, processedSlugs)} slug dirs scanned — ${JSON.stringify(tally)}`);
    }
  }

  console.log(`[cleanup] final tally: ${JSON.stringify(tally, null, 2)}`);
  if (dryRun) {
    console.log(`[cleanup] dry-run — no objects deleted. Re-run without --dry-run to apply.`);
  } else if (tally.deleted > 0) {
    console.log(`[cleanup] done. Deleted ${tally.deleted} retired-augmentation objects.`);
  } else {
    console.log(`[cleanup] done. No retired objects found — already clean or first-run already shipped.`);
  }
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err?.stack ?? err);
  process.exit(1);
});
