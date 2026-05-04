#!/usr/bin/env node
// Dump a "smart catalog pool" of slugs + image URLs that the fine-tune
// will use as the candidate set for hard-negative mining.
//
// Why a SUBSET and not all 24k canonical_cards: full-catalog embedding
// takes 20+ min on MPS and produces hundreds of MB of tensors. The hard-
// negative miner only needs candidates that COULD plausibly confuse a
// train-set anchor — the rest are wasted compute. A targeted pool of
// ~3-5k slugs covers the actual confusion surface.
//
// Pool composition (union, deduped):
//   1. All slugs already in the dataset's train + val sets (the model
//      MUST see its own labeled cards in the candidate pool — they're
//      the true positives at inference time).
//   2. All slugs sharing canonical_name with any train/val slug
//      (variant siblings: Pikachu V vs Pikachu VMAX vs Pikachu ex).
//   3. All slugs in the same set_name as any train/val slug (set-mate
//      confusion).
//   4. All slugs that appeared as a wrong top-1 prediction in the
//      most recent eval run (the empirical lighthouses + their
//      victims).
//   5. A random sample of N additional EN slugs for general coverage
//      (default 1000), drawn deterministically by --seed.
//
// Output (default ./data/catalog-pool.json):
//   {
//     "generated_at": ...,
//     "n_total": N,
//     "sources": { "train_val": ..., "name_siblings": ..., ... },
//     "items": [{ "slug": ..., "canonical_name": ..., "set_name": ...,
//                 "card_number": ..., "language": ...,
//                 "mirrored_primary_image_url": ..., "source": "..." }]
//   }
//
// Usage:
//   npm run dataset:catalog-pool
//   npm run dataset:catalog-pool -- --dataset ./data/finetune-2026-04-29-disjoint
//   npm run dataset:catalog-pool -- --random-sample 2000 --seed 42
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_RANDOM_SAMPLE = 1000;
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

function makeRng(seed) {
  // xorshift32 — same PRNG used by the dataset:export split for
  // determinism with --seed.
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function loadDatasetSlugs(datasetDir) {
  // Read train.jsonl + val.jsonl positives to seed the pool.
  const slugs = new Set();
  const names = new Set();
  const sets = new Set();
  for (const file of ["train.jsonl", "val.jsonl"]) {
    const filePath = path.join(datasetDir, file);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.positive?.slug) slugs.add(row.positive.slug);
        if (row.positive?.canonical_name) names.add(row.positive.canonical_name);
        if (row.positive?.set_name) sets.add(row.positive.set_name);
      } catch {
        // Skip malformed line — dataset:export shouldn't produce them.
      }
    }
  }
  return { slugs, names, sets };
}

async function main() {
  const args = parseArgs(process.argv);
  const datasetDir = args.dataset
    ? path.resolve(args.dataset)
    : path.resolve("./data/finetune-2026-04-29-disjoint");
  const outPath = args.out ?? path.join(datasetDir, "catalog-pool.json");
  const randomSample = Number.parseInt(args["random-sample"] ?? `${DEFAULT_RANDOM_SAMPLE}`, 10);
  const seed = Number.parseInt(args.seed ?? `${DEFAULT_SEED}`, 10);
  const evalRunId = typeof args["eval-run"] === "string" ? args["eval-run"] : null;

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  console.log(`[pool] dataset=${datasetDir} out=${outPath} randomSample=${randomSample} seed=${seed}`);

  const { slugs: dsSlugs, names: dsNames, sets: dsSets } = loadDatasetSlugs(datasetDir);
  console.log(`[pool] dataset seeds: ${dsSlugs.size} slugs, ${dsNames.size} canonical_names, ${dsSets.size} sets`);

  // 1. Train + val slugs themselves.
  const wantedSlugs = new Map(); // slug -> source-tag
  for (const slug of dsSlugs) wantedSlugs.set(slug, "train_val");

  // 2. Sibling slugs by canonical_name (variant lineages).
  if (dsNames.size > 0) {
    const { data: sibs, error: sibsErr } = await supabase
      .from("canonical_cards")
      .select("slug")
      .in("canonical_name", [...dsNames])
      .eq("language", "EN");
    if (sibsErr) throw new Error(`sibling lookup: ${sibsErr.message}`);
    let added = 0;
    for (const row of sibs ?? []) {
      if (!wantedSlugs.has(row.slug)) {
        wantedSlugs.set(row.slug, "name_siblings");
        added += 1;
      }
    }
    console.log(`[pool] +${added} name_siblings (slugs sharing canonical_name)`);
  }

  // 3. Set-mate slugs (everything in the same sets as our anchors).
  if (dsSets.size > 0) {
    const { data: setMates, error: setMatesErr } = await supabase
      .from("canonical_cards")
      .select("slug")
      .in("set_name", [...dsSets])
      .eq("language", "EN");
    if (setMatesErr) throw new Error(`set-mate lookup: ${setMatesErr.message}`);
    let added = 0;
    for (const row of setMates ?? []) {
      if (!wantedSlugs.has(row.slug)) {
        wantedSlugs.set(row.slug, "set_mates");
        added += 1;
      }
    }
    console.log(`[pool] +${added} set_mates (slugs in same sets)`);
  }

  // 4. Lighthouses + their victims from the most recent eval run.
  let runRow = null;
  if (evalRunId) {
    const { data, error } = await supabase
      .from("scan_eval_runs")
      .select("id, detailed_results")
      .eq("id", evalRunId)
      .maybeSingle();
    if (error) throw new Error(`eval run ${evalRunId}: ${error.message}`);
    runRow = data;
  } else {
    const { data, error } = await supabase
      .from("scan_eval_runs")
      .select("id, detailed_results")
      .order("ran_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`latest eval run: ${error.message}`);
    runRow = data?.[0];
  }
  if (runRow) {
    const evalSlugs = new Set();
    for (const r of runRow.detailed_results ?? []) {
      if (r.actual_top1) evalSlugs.add(r.actual_top1);
      if (r.expected_slug) evalSlugs.add(r.expected_slug);
      for (const s of r.actual_top5 ?? []) evalSlugs.add(s);
    }
    let added = 0;
    for (const slug of evalSlugs) {
      if (!wantedSlugs.has(slug)) {
        wantedSlugs.set(slug, "eval_lighthouse");
        added += 1;
      }
    }
    console.log(`[pool] +${added} eval_lighthouse from run ${runRow.id} (predictions + targets in ${runRow.detailed_results?.length ?? 0} rows)`);
  }

  // 5. Random sample for general coverage of the embedding space.
  if (randomSample > 0) {
    // Get a count first, then random-OFFSET sample. Could also use
    // pg's tablesample but Supabase JS client doesn't expose it.
    const rng = makeRng(seed);
    const { count, error: countErr } = await supabase
      .from("canonical_cards")
      .select("*", { count: "exact", head: true })
      .eq("language", "EN");
    if (countErr) throw new Error(`count canonical_cards: ${countErr.message}`);

    if (count && count > 0) {
      const offsets = new Set();
      const target = Math.min(randomSample, count);
      while (offsets.size < target) {
        offsets.add(Math.floor(rng() * count));
      }
      // Fetch in pages of 1000 for efficiency. The `.range()` API gets
      // a contiguous slice; we need scattered indices, so we just read
      // the whole range we'd cover and pick.
      // Cheap approximation: order by created_at, paginate, take every
      // (count/target)th row. Not truly random but deterministic and
      // covers the corpus.
      const stride = Math.max(1, Math.floor(count / target));
      const startOffset = Math.floor(rng() * stride); // small jitter
      let added = 0;
      const PAGE = 1000;
      for (let off = startOffset; off < count && added < target; off += PAGE) {
        const { data: page, error: pageErr } = await supabase
          .from("canonical_cards")
          .select("slug")
          .eq("language", "EN")
          .order("slug", { ascending: true })
          .range(off, off + PAGE - 1);
        if (pageErr) throw new Error(`random sample page (off=${off}): ${pageErr.message}`);
        for (let i = 0; i < (page ?? []).length; i += stride) {
          const slug = page[i]?.slug;
          if (slug && !wantedSlugs.has(slug)) {
            wantedSlugs.set(slug, "random_sample");
            added += 1;
            if (added >= target) break;
          }
        }
      }
      console.log(`[pool] +${added} random_sample (~stride=${stride})`);
    }
  }

  console.log(`[pool] candidate slug count: ${wantedSlugs.size} (raw, before URL filter)`);

  // 6. Resolve URLs + metadata. Filter out any slug missing
  //    mirrored_primary_image_url — those would just fail to embed.
  //    Smaller PAGE size + retry: Supabase's REST gateway can fail on
  //    very long URL query strings (500 slugs = ~25KB URL).
  const allSlugs = [...wantedSlugs.keys()];
  const items = [];
  const PAGE = 100;
  const RETRIES = 3;
  for (let i = 0; i < allSlugs.length; i += PAGE) {
    const chunk = allSlugs.slice(i, i + PAGE);
    let data = null;
    let lastErr = null;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const res = await supabase
          .from("canonical_cards")
          .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
          .in("slug", chunk);
        if (res.error) {
          lastErr = res.error;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        data = res.data;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (data === null) {
      console.warn(`[pool] failed chunk @ offset ${i}: ${lastErr?.message ?? lastErr}; skipping ${chunk.length} slugs`);
      continue;
    }
    for (const row of data) {
      if (!row.mirrored_primary_image_url) continue;
      items.push({
        slug: row.slug,
        canonical_name: row.canonical_name,
        set_name: row.set_name,
        card_number: row.card_number,
        language: row.language,
        mirrored_primary_image_url: row.mirrored_primary_image_url,
        source: wantedSlugs.get(row.slug),
      });
    }
    if ((i + PAGE) % 1000 < PAGE) {
      console.log(`[pool] resolved ${Math.min(i + PAGE, allSlugs.length)}/${allSlugs.length} URLs`);
    }
  }

  const sources = items.reduce((acc, item) => {
    acc[item.source] = (acc[item.source] ?? 0) + 1;
    return acc;
  }, {});

  const out = {
    generated_at: new Date().toISOString(),
    dataset_dir: datasetDir,
    eval_run_id: runRow?.id ?? null,
    flags: { randomSample, seed },
    n_total: items.length,
    sources,
    items,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`[pool] wrote ${outPath}`);
  console.log(`[pool] n_total=${items.length} · sources=${JSON.stringify(sources)}`);
}

main().catch((err) => {
  console.error("[pool] fatal:", err?.stack ?? err);
  process.exit(1);
});
