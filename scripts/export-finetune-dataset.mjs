#!/usr/bin/env node
// Export the scanner fine-tune training set from `scan_eval_images` +
// `canonical_cards` + `scan_eval_runs.detailed_results` into JSONL +
// downloaded anchor JPEGs. Stage D Step 1 of the scanner-augmentation
// playbook — the data side of the fine-tune. The actual training loop
// (Stage D Step 2) reads this manifest and is implemented separately.
//
// Why this format:
//   • One JSONL line per anchor user-photo, the natural training row.
//   • `positive` = the catalog art for the labeled canonical_slug.
//   • `hard_negatives` = a curated list of slugs we expect the model
//     to push AWAY from the anchor in embedding space:
//       (a) actual misidentifications mined from the most recent eval
//           run — every wrong top-1 is a real-world hard negative.
//       (b) variant siblings — same canonical_name, different slug
//           (Pikachu V vs Pikachu VMAX vs Pikachu ex). Even when the
//           model gets the anchor right today, these are the visual
//           confusion pairs we know need contrastive separation.
//   • Catalog images are stored as URLs — the training script downloads
//     them on demand. Anchor JPEGs are pre-downloaded because they live
//     in our private bucket and re-authenticating per epoch is silly.
//   • Train/val split is stratified by `canonical_slug` so no slug
//     appears in both sets. Eval-set leakage would inflate val metrics.
//
// Usage:
//   npm run dataset:export
//   npm run dataset:export -- --out ./data/finetune-2026-04-28 --val-frac 0.20
//
// Flags:
//   --out <dir>           Output directory. Default ./data/finetune-<YYYY-MM-DD>.
//   --val-frac <0..1>     Validation fraction (per-slug stratified). Default 0.20.
//   --eval-run <uuid>     Run id for hard-negative mining. Default = most recent.
//   --max-hard-negs <n>   Per-anchor cap on hard negatives. Default 8.
//   --no-anchor-download  Skip JPEG downloads (e.g. for a fast schema check).
//   --dry-run             Print summary, write nothing to disk.
//   --language <EN|JP>    Filter anchors by captured_language.
//   --seed <int>          PRNG seed for the train/val split. Default 42.
//
// Output:
//   <out>/manifest.json   Run-level stats + flag values + dataset version.
//   <out>/train.jsonl     Training rows (~80%).
//   <out>/val.jsonl       Validation rows (~20%, stratified).
//   <out>/images/<hash>.jpg
//                         Anchor photos. Skipped if --no-anchor-download.
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// The dataset format version (DATASET_VERSION below) is bumped whenever
// the row schema changes incompatibly so a training script can refuse
// to load a stale dataset.

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const IMAGE_BUCKET = "card-images";
const DATASET_VERSION = "scanner-finetune-v1";
const DEFAULT_VAL_FRAC = 0.20;
const DEFAULT_MAX_HARD_NEGS = 8;
const DEFAULT_SEED = 42;

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

// xorshift32 — deterministic PRNG so a given --seed always yields the
// same train/val split. Math.random() would defeat reproducibility.
function makeRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function loadAnchors(supabase, language) {
  let q = supabase
    .from("scan_eval_images")
    .select(
      "id, canonical_slug, image_storage_path, image_hash, image_bytes_size, captured_source, captured_language, notes, created_at",
    )
    .order("created_at", { ascending: true });
  if (language) q = q.eq("captured_language", language);
  const { data, error } = await q;
  if (error) throw new Error(`load scan_eval_images: ${error.message}`);
  return data ?? [];
}

async function loadCanonicalCards(supabase, slugs) {
  if (slugs.length === 0) return new Map();
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
    .in("slug", [...new Set(slugs)]);
  if (error) throw new Error(`load canonical_cards: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.slug, row]));
}

async function loadVariantSiblings(supabase, names, exclude) {
  if (names.length === 0) return new Map();
  // Variant siblings = same canonical_name, different slug. Bounded to
  // language=EN for now — JP corpus is too sparse to stratify by both.
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
    .in("canonical_name", [...new Set(names)])
    .eq("language", "EN");
  if (error) throw new Error(`load variant siblings: ${error.message}`);
  const byName = new Map();
  for (const row of data ?? []) {
    if (exclude.has(row.slug)) continue; // skip anchors' own slug
    if (!byName.has(row.canonical_name)) byName.set(row.canonical_name, []);
    byName.get(row.canonical_name).push(row);
  }
  return byName;
}

async function pickConfusionNegatives(supabase, evalRunId) {
  // Mine (image_id, wrong_top1) pairs from the named eval run's
  // detailed_results so we can attach the model's actual mistakes as
  // hard negatives. Returns Map<image_id, Array<wrong_slug>>.
  const out = new Map();
  let runRow;
  if (evalRunId) {
    const { data, error } = await supabase
      .from("scan_eval_runs")
      .select("id, detailed_results")
      .eq("id", evalRunId)
      .maybeSingle();
    if (error) throw new Error(`load eval run ${evalRunId}: ${error.message}`);
    runRow = data;
  } else {
    const { data, error } = await supabase
      .from("scan_eval_runs")
      .select("id, detailed_results, ran_at")
      .order("ran_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`load latest eval run: ${error.message}`);
    runRow = data?.[0];
  }
  if (!runRow) return { byImageId: out, runId: null };
  for (const detail of runRow.detailed_results ?? []) {
    if (detail.error) continue;
    const expected = detail.expected_slug;
    const actual = detail.actual_top1;
    if (!expected || !actual || expected === actual) continue;
    const list = out.get(detail.image_id) ?? [];
    list.push(actual);
    out.set(detail.image_id, list);
  }
  return { byImageId: out, runId: runRow.id };
}

async function downloadAnchor(supabase, storagePath, outPath) {
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).download(storagePath);
  if (error) throw new Error(`storage download ${storagePath}: ${error.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return buf.byteLength;
}

function buildHardNegatives({
  anchorSlug,
  confusions,
  variantSiblings,
  catalog,
  maxHardNegs,
}) {
  const seen = new Set([anchorSlug]);
  const out = [];

  // (a) Confusion pairs first — these are the model's actual mistakes
  // and represent the strongest hard-negative signal we have.
  for (const wrongSlug of confusions ?? []) {
    if (seen.has(wrongSlug)) continue;
    const meta = catalog.get(wrongSlug);
    if (!meta) continue; // orphan — already filtered by Track A
    seen.add(wrongSlug);
    out.push({
      slug: meta.slug,
      canonical_name: meta.canonical_name,
      set_name: meta.set_name,
      card_number: meta.card_number,
      mirrored_primary_image_url: meta.mirrored_primary_image_url,
      source: "eval_confusion_pair",
    });
    if (out.length >= maxHardNegs) return out;
  }

  // (b) Variant siblings — same character, different printing. Add up
  // to half the remaining budget here so confusions stay dominant when
  // both sources have data.
  const remaining = maxHardNegs - out.length;
  let budget = Math.max(1, Math.floor(remaining / 2));
  for (const sib of variantSiblings ?? []) {
    if (budget <= 0) break;
    if (seen.has(sib.slug)) continue;
    seen.add(sib.slug);
    out.push({
      slug: sib.slug,
      canonical_name: sib.canonical_name,
      set_name: sib.set_name,
      card_number: sib.card_number,
      mirrored_primary_image_url: sib.mirrored_primary_image_url,
      source: "variant_sibling",
    });
    budget -= 1;
    if (out.length >= maxHardNegs) return out;
  }

  return out;
}

function stratifiedSplit(rows, valFrac, seed) {
  // Group by anchor slug, shuffle within group, take ceil(n*valFrac)
  // for val. Keeps slugs disjoint across train/val so val accuracy
  // measures generalization, not memorization.
  const rng = makeRng(seed);
  const bySlug = new Map();
  for (const row of rows) {
    if (!bySlug.has(row.positive.slug)) bySlug.set(row.positive.slug, []);
    bySlug.get(row.positive.slug).push(row);
  }
  const train = [];
  const val = [];
  for (const list of bySlug.values()) {
    const shuffled = [...list].sort(() => rng() - 0.5);
    const valCount = Math.min(shuffled.length, Math.max(1, Math.round(shuffled.length * valFrac)));
    // Keep at least 1 in train per slug if there's >= 2 photos; if
    // there's only 1 photo of a slug, send it to train (val would
    // make it untrainable).
    if (shuffled.length === 1) {
      train.push(shuffled[0]);
      continue;
    }
    val.push(...shuffled.slice(0, valCount));
    train.push(...shuffled.slice(valCount));
  }
  return { train, val };
}

async function main() {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const outDir = args.out || `./data/finetune-${todayStamp()}`;
  const valFrac = Number.parseFloat(args["val-frac"] ?? `${DEFAULT_VAL_FRAC}`);
  const maxHardNegs = Number.parseInt(args["max-hard-negs"] ?? `${DEFAULT_MAX_HARD_NEGS}`, 10);
  const seed = Number.parseInt(args.seed ?? `${DEFAULT_SEED}`, 10);
  const evalRunId = typeof args["eval-run"] === "string" ? args["eval-run"] : null;
  const language = typeof args.language === "string" ? args.language.toUpperCase() : null;
  const skipDownload = Boolean(args["no-anchor-download"]);
  const dryRun = Boolean(args["dry-run"]);

  console.log(`[export] config:`, { outDir, valFrac, maxHardNegs, seed, evalRunId, language, skipDownload, dryRun });

  const anchors = await loadAnchors(supabase, language);
  console.log(`[export] anchors loaded: ${anchors.length}`);

  const slugs = anchors.map((a) => a.canonical_slug);
  const catalog = await loadCanonicalCards(supabase, slugs);
  console.log(`[export] canonical cards resolved: ${catalog.size} / ${new Set(slugs).size} unique slugs`);

  const positiveCanonicalNames = [...new Set(
    [...catalog.values()].map((c) => c.canonical_name),
  )];
  const variantSiblingsByName = await loadVariantSiblings(
    supabase,
    positiveCanonicalNames,
    new Set(slugs),
  );
  console.log(`[export] variant siblings indexed for ${variantSiblingsByName.size} canonical_names`);

  const { byImageId: confusionsByImageId, runId: confusionRunId } =
    await pickConfusionNegatives(supabase, evalRunId);
  console.log(
    `[export] confusion-pair source: run=${confusionRunId ?? "(none)"} · ${confusionsByImageId.size} anchors with ≥1 misidentification`,
  );

  // To populate confusion negatives' metadata we need their canonical
  // rows too (they're predicted slugs that may not be in our anchor
  // set). Pull those in a second batch.
  const confusionSlugs = new Set();
  for (const list of confusionsByImageId.values()) {
    for (const slug of list) confusionSlugs.add(slug);
  }
  const confusionMeta = await loadCanonicalCards(supabase, [...confusionSlugs]);
  for (const [slug, row] of confusionMeta) catalog.set(slug, row);
  console.log(`[export] confusion-pair metadata resolved: ${confusionMeta.size}`);

  const rows = [];
  let skippedNoCanonical = 0;
  for (const anchor of anchors) {
    const positive = catalog.get(anchor.canonical_slug);
    if (!positive) {
      skippedNoCanonical += 1;
      continue;
    }
    const hardNegs = buildHardNegatives({
      anchorSlug: anchor.canonical_slug,
      confusions: confusionsByImageId.get(anchor.id),
      variantSiblings: variantSiblingsByName.get(positive.canonical_name),
      catalog,
      maxHardNegs,
    });
    rows.push({
      anchor_id: anchor.id,
      anchor_local_path: `images/${anchor.image_hash}.jpg`,
      anchor_storage_path: anchor.image_storage_path,
      anchor_hash: anchor.image_hash,
      anchor_bytes_size: anchor.image_bytes_size,
      captured_source: anchor.captured_source,
      captured_language: anchor.captured_language,
      notes: anchor.notes,
      created_at: anchor.created_at,
      positive: {
        slug: positive.slug,
        canonical_name: positive.canonical_name,
        set_name: positive.set_name,
        card_number: positive.card_number,
        language: positive.language,
        mirrored_primary_image_url: positive.mirrored_primary_image_url,
      },
      hard_negatives: hardNegs,
    });
  }
  console.log(`[export] rows built: ${rows.length} (skipped ${skippedNoCanonical} with no canonical_card)`);

  const { train, val } = stratifiedSplit(rows, valFrac, seed);
  console.log(`[export] split: train=${train.length} · val=${val.length}`);

  // Stats — useful in the manifest and for catching obvious gaps.
  const stats = {
    anchors_total: rows.length,
    distinct_slugs: new Set(rows.map((r) => r.positive.slug)).size,
    avg_hard_negatives: rows.length === 0
      ? 0
      : rows.reduce((s, r) => s + r.hard_negatives.length, 0) / rows.length,
    rows_with_confusion_negatives: rows.filter((r) =>
      r.hard_negatives.some((n) => n.source === "eval_confusion_pair"),
    ).length,
    rows_with_no_hard_negatives: rows.filter((r) => r.hard_negatives.length === 0).length,
    distinct_conditions: [...new Set(rows.map((r) => r.notes ?? "(null)"))],
  };
  console.log(`[export] stats:`, stats);

  if (dryRun) {
    console.log(`[export] dry-run — no files written.`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const imagesDir = path.join(outDir, "images");
  if (!skipDownload) fs.mkdirSync(imagesDir, { recursive: true });

  const trainPath = path.join(outDir, "train.jsonl");
  const valPath = path.join(outDir, "val.jsonl");
  fs.writeFileSync(trainPath, train.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(valPath, val.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`[export] wrote ${trainPath} (${train.length} rows) · ${valPath} (${val.length} rows)`);

  if (!skipDownload) {
    let downloaded = 0;
    let skippedExisting = 0;
    let downloadFailed = 0;
    for (const row of rows) {
      const localPath = path.join(outDir, row.anchor_local_path);
      if (fs.existsSync(localPath)) {
        skippedExisting += 1;
        continue;
      }
      try {
        await downloadAnchor(supabase, row.anchor_storage_path, localPath);
        downloaded += 1;
      } catch (err) {
        downloadFailed += 1;
        console.warn(`[export] download failed ${row.anchor_storage_path}: ${err.message}`);
      }
      if ((downloaded + skippedExisting) % 25 === 0) {
        console.log(
          `[export] download progress: ${downloaded + skippedExisting}/${rows.length} (downloaded ${downloaded}, cached ${skippedExisting}, failed ${downloadFailed})`,
        );
      }
    }
    console.log(`[export] downloads: ${downloaded} new · ${skippedExisting} cached · ${downloadFailed} failed`);
    stats.anchor_downloads_failed = downloadFailed;
  }

  const manifest = {
    dataset_version: DATASET_VERSION,
    generated_at: new Date().toISOString(),
    out_dir: path.resolve(outDir),
    confusion_run_id: confusionRunId,
    flags: { valFrac, maxHardNegs, seed, language, skipDownload },
    stats,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[export] wrote ${manifestPath}`);
  console.log(`[export] done.`);
}

main().catch((err) => {
  console.error("[export] fatal:", err?.stack ?? err);
  process.exit(1);
});
