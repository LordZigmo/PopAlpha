#!/usr/bin/env node
// Run the scanner eval corpus against `/api/scan/identify` and
// persist one scan_eval_runs row with the full scoreboard.
//
// Usage:
//   npm run eval:run
//   npm run eval:run -- --endpoint http://localhost:3000 --notes "after crop padding change"
//
// Flags:
//   --endpoint <url>     Where to POST scans. Default https://popalpha.ai.
//   --language <EN|JP>   Which slice of the eval set to run. Default runs all.
//   --sources <csv>      Optional comma-separated captured_source filter.
//   --throttle-ms <n>    Gap between requests (default 300) so we don't
//                        hammer Replicate while we're rate-limited.
//   --notes "<text>"     Free-form annotation on the run row.
//
// Output: human-readable summary to stdout + exit code 0 on success.
// Fails with exit 1 if the corpus is empty or the endpoint rejected
// every request — use that for CI gates later.
//
// Requires:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (for DB + Storage reads)

import { createClient } from "@supabase/supabase-js";

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

function fmtPct(numerator, denominator) {
  if (!denominator) return "-";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchImageBytes(supabase, storagePath) {
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).download(storagePath);
  if (error) throw new Error(`storage download ${storagePath}: ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function identify({ endpoint, bytes, language, cardNumber }) {
  const url = new URL("/api/scan/identify", endpoint);
  url.searchParams.set("language", language);
  // Optional card_number filter — when set, the route narrows kNN
  // candidates to canonical_cards where card_number matches. The eval
  // harness passes the ground-truth card_number to measure the
  // "perfect OCR" ceiling: an upper bound for any future on-device
  // text-recognition path (iOS Vision etc.).
  if (cardNumber) url.searchParams.set("card_number", cardNumber);

  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "image/jpeg",
      // Tag eval traffic so scan_identify_events telemetry can
      // segment it out of real user analytics.
      "X-PA-Client-Platform": "scanner-eval",
    },
    body: bytes,
  });
  const duration = Date.now() - startedAt;

  const bodyText = await response.text();
  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    duration,
    body: parsed,
    rawBody: bodyText,
  };
}

function accumulate(acc, key, field) {
  const bucket = acc[key] ?? { n: 0, top1: 0, top5: 0 };
  bucket.n += 1;
  if (field.top1) bucket.top1 += 1;
  if (field.top5) bucket.top5 += 1;
  acc[key] = bucket;
  return acc;
}

async function main() {
  const args = parseArgs(process.argv);
  const endpoint = typeof args.endpoint === "string" ? args.endpoint : "https://popalpha.ai";
  const languageFilter =
    typeof args.language === "string" ? args.language.toUpperCase() : null;
  const sourceFilter =
    typeof args.sources === "string"
      ? args.sources.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
  const throttleMs = Number.parseInt(args["throttle-ms"] ?? "300", 10);
  const notes = typeof args.notes === "string" ? args.notes : null;
  // Pass each anchor's GROUND-TRUTH card_number to the route as the
  // ?card_number= filter. Simulates a perfect OCR result and measures
  // the upper bound of any future on-device text-recognition path.
  // Without this flag the eval behaves identically to before.
  const perfectOcr = Boolean(args["perfect-ocr"]);

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  let query = supabase
    .from("scan_eval_images")
    .select("id, canonical_slug, image_storage_path, image_bytes_size, captured_source, captured_language, notes")
    .order("created_at", { ascending: true });
  if (languageFilter) query = query.eq("captured_language", languageFilter);
  if (sourceFilter && sourceFilter.length) query = query.in("captured_source", sourceFilter);

  const { data: images, error } = await query;
  if (error) {
    console.error(`Failed to load eval corpus: ${error.message}`);
    process.exit(2);
  }
  if (!images.length) {
    console.error("No images in scan_eval_images matching filter. Seed some first with `npm run eval:seed -- ...`.");
    process.exit(1);
  }

  // Pull ground-truth card_number for each anchor's expected slug when
  // --perfect-ocr is set. Cheap one-shot batch query.
  const cardNumberBySlug = new Map();
  if (perfectOcr) {
    const slugs = [...new Set(images.map((img) => img.canonical_slug))];
    const { data: ccRows, error: ccErr } = await supabase
      .from("canonical_cards")
      .select("slug, card_number")
      .in("slug", slugs);
    if (ccErr) {
      console.error(`Failed to load canonical card_numbers: ${ccErr.message}`);
      process.exit(2);
    }
    for (const row of ccRows ?? []) {
      cardNumberBySlug.set(row.slug, row.card_number ?? null);
    }
    console.log(
      `[eval] perfect-ocr: pulled card_number for ${cardNumberBySlug.size} of ${slugs.length} unique slugs`,
    );
  }

  console.log(
    `\nScanner eval — ${images.length} images → ${endpoint}` +
      (languageFilter ? ` (language=${languageFilter})` : "") +
      (sourceFilter ? ` (sources=${sourceFilter.join(",")})` : "") +
      (perfectOcr ? " (perfect-ocr)" : "") +
      "\n",
  );

  const header = "    idx  result  conf    sim     gap     expected                              actual                                 ms";
  console.log(header);
  console.log("    " + "-".repeat(header.length - 4));

  const detailed = [];
  const perSet = {};
  const perSource = {};
  let nTop1 = 0;
  let nTop5 = 0;
  let nHigh = 0;
  let nMedium = 0;
  let nLow = 0;
  let nErrors = 0;
  let modelVersion = "unknown";
  const runStartedAt = Date.now();

  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const indexLabel = String(i + 1).padStart(3);
    try {
      const bytes = await fetchImageBytes(supabase, image.image_storage_path);
      const result = await identify({
        endpoint,
        bytes,
        language: image.captured_language,
        cardNumber: perfectOcr ? cardNumberBySlug.get(image.canonical_slug) ?? null : null,
      });

      if (!result.ok || !result.body?.ok) {
        nErrors += 1;
        const errSnippet = (result.body?.error ?? result.rawBody ?? `HTTP ${result.status}`).slice(0, 80);
        console.log(
          `    ${indexLabel}  ERR     -       -       -       ${image.canonical_slug.padEnd(36).slice(0, 36)}  ${errSnippet}`,
        );
        detailed.push({
          image_id: image.id,
          expected_slug: image.canonical_slug,
          actual_top1: null,
          actual_top5: [],
          similarity: null,
          gap_to_rank_2: null,
          confidence: "error",
          duration_ms: result.duration,
          error: errSnippet,
          source: image.captured_source,
        });
        continue;
      }

      const body = result.body;
      modelVersion = body.model_version ?? modelVersion;
      const matches = Array.isArray(body.matches) ? body.matches : [];
      const top1 = matches[0]?.slug ?? null;
      const top5 = matches.slice(0, 5).map((m) => m.slug);
      const similarity = typeof matches[0]?.similarity === "number" ? matches[0].similarity : null;
      const rank2Similarity =
        typeof matches[1]?.similarity === "number" ? matches[1].similarity : null;
      const gap = similarity !== null && rank2Similarity !== null ? similarity - rank2Similarity : null;
      const isTop1 = top1 === image.canonical_slug;
      const isTop5 = top5.includes(image.canonical_slug);
      const confidence = body.confidence ?? "unknown";

      if (isTop1) nTop1 += 1;
      if (isTop5) nTop5 += 1;
      if (confidence === "high") nHigh += 1;
      else if (confidence === "medium") nMedium += 1;
      else if (confidence === "low") nLow += 1;

      const setName = image.canonical_slug.split("-").slice(0, -2).join("-") || "unknown";
      accumulate(perSet, setName, { top1: isTop1, top5: isTop5 });
      accumulate(perSource, image.captured_source, { top1: isTop1, top5: isTop5 });

      detailed.push({
        image_id: image.id,
        expected_slug: image.canonical_slug,
        actual_top1: top1,
        actual_top5: top5,
        similarity,
        gap_to_rank_2: gap,
        confidence,
        duration_ms: result.duration,
        error: null,
        source: image.captured_source,
      });

      const marker = isTop1 ? " ✓ " : isTop5 ? " ~ " : " ✗ ";
      const simText = similarity !== null ? similarity.toFixed(4) : "-";
      const gapText = gap !== null ? gap.toFixed(4) : "-";
      console.log(
        `    ${indexLabel}  ${marker}   ${confidence.padEnd(6)}  ${simText}  ${gapText}  ${image.canonical_slug.padEnd(36).slice(0, 36)}  ${(top1 ?? "<none>").padEnd(36).slice(0, 36)}  ${String(result.duration).padStart(5)}`,
      );
    } catch (err) {
      nErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `    ${indexLabel}  ERR     -       -       -       ${image.canonical_slug.padEnd(36).slice(0, 36)}  ${msg.slice(0, 80)}`,
      );
      detailed.push({
        image_id: image.id,
        expected_slug: image.canonical_slug,
        actual_top1: null,
        actual_top5: [],
        similarity: null,
        gap_to_rank_2: null,
        confidence: "error",
        duration_ms: null,
        error: msg.slice(0, 200),
        source: image.captured_source,
      });
    }

    if (throttleMs > 0 && i < images.length - 1) {
      await sleep(throttleMs);
    }
  }

  const runDuration = Date.now() - runStartedAt;
  const nTotal = images.length;

  console.log("");
  console.log(`    Results: ${nTop1}/${nTotal} top-1 (${fmtPct(nTop1, nTotal)}) · ${nTop5}/${nTotal} top-5 (${fmtPct(nTop5, nTotal)}) · ${nErrors} errors`);
  console.log(`    Confidence: ${nHigh} high · ${nMedium} medium · ${nLow} low`);
  console.log(`    Model: ${modelVersion}`);
  console.log(`    Duration: ${(runDuration / 1000).toFixed(1)}s (${Math.round(runDuration / nTotal)}ms/image avg)`);
  console.log("");

  const setRows = Object.entries(perSet)
    .sort(([, a], [, b]) => b.n - a.n)
    .slice(0, 8);
  if (setRows.length) {
    console.log("    Top sets by count:");
    for (const [set, counts] of setRows) {
      console.log(`      ${set.padEnd(28).slice(0, 28)}  ${counts.top1}/${counts.n} top-1 (${fmtPct(counts.top1, counts.n)})`);
    }
    console.log("");
  }

  const runInsert = await supabase
    .from("scan_eval_runs")
    .insert({
      model_version: modelVersion,
      endpoint_url: endpoint,
      crop_params: {},
      confidence_thresholds: {},
      n_total: nTotal,
      n_top1_correct: nTop1,
      n_top5_correct: nTop5,
      n_confidence_high: nHigh,
      n_confidence_medium: nMedium,
      n_confidence_low: nLow,
      n_errors: nErrors,
      per_set_accuracy: perSet,
      per_source_accuracy: perSource,
      detailed_results: detailed,
      duration_ms: runDuration,
      notes,
    })
    .select("id")
    .maybeSingle();
  if (runInsert.error) {
    console.error(`Failed to persist run: ${runInsert.error.message}`);
    process.exit(2);
  }
  console.log(`    Run persisted: ${runInsert.data?.id}\n`);

  // Compare to previous run on the same endpoint so every invocation
  // tells you whether the change you just made helped or hurt.
  const previousRun = await supabase
    .from("scan_eval_runs")
    .select("id, ran_at, n_total, n_top1_correct, n_top5_correct, n_confidence_high, notes")
    .eq("endpoint_url", endpoint)
    .neq("id", runInsert.data?.id)
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousRun.data) {
    const prev = previousRun.data;
    const top1Delta = nTop1 - prev.n_top1_correct;
    const top5Delta = nTop5 - prev.n_top5_correct;
    const highDelta = nHigh - prev.n_confidence_high;
    console.log(`    vs. previous run (${prev.id}):`);
    console.log(`      top-1:      ${(top1Delta >= 0 ? "+" : "") + top1Delta} / Δ${fmtPct(top1Delta, prev.n_total)}`);
    console.log(`      top-5:      ${(top5Delta >= 0 ? "+" : "") + top5Delta} / Δ${fmtPct(top5Delta, prev.n_total)}`);
    console.log(`      high conf:  ${(highDelta >= 0 ? "+" : "") + highDelta}`);
    if (prev.notes) console.log(`      prev notes: ${prev.notes}`);
    console.log("");
  }

  process.exit(nErrors === nTotal ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err?.stack ?? err);
  process.exit(1);
});
