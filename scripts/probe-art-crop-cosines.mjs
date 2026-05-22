#!/usr/bin/env node
/**
 * probe-art-crop-cosines
 *
 * Pre-flight test for the EN<->JP art-crop pairing path. We need to
 * validate the hypothesis that cross-language SigLIP cosine on
 * ART-ONLY crops will discriminate same-art from different-art pairs,
 * BEFORE committing to a ~20-35 hour drain of art-crop embeddings
 * across the 46k canonical_cards corpus.
 *
 * Today (full-card SigLIP):
 *   same-art   same-language : 0.92-0.96   <- clean signal
 *   same-art   cross-language: 0.7758      <- text noise swamps art signal
 *   diff-art   same-Pokemon  : 0.75-0.80   <- overlaps true positives
 *
 * Hypothesis: stripping the JP/EN text region (via artCropTransform)
 * before embedding should recover the same-language cosine band for
 * true-art-equivalent pairs across language.
 *
 * What this script does:
 *   1. For each (EN slug, JP slug, label) tuple in PAIRS below
 *   2. Fetch mirrored_primary_image_url for both from canonical_cards
 *   3. fetch() the image bytes
 *   4. artCropTransform(buf) -> crop to illustration window
 *   5. ModalSiglipEmbedder.embedBytes -> 768-d embedding
 *   6. Compute cosine between EN/JP vectors
 *   7. Print a table: SAME_ART pairs should land HIGH (>= 0.90?),
 *      DIFFERENT_ART pairs should land LOW.
 *
 * Decision rule:
 *   - SAME_ART >= 0.90  AND  DIFFERENT_ART <= 0.82  -> drain validated, proceed
 *   - signal improves but bands overlap              -> drain alone won't fix; pivot
 *   - no improvement vs full-card baselines          -> crop is wrong or model is wrong
 *
 * Cost: ~6 cards * 2 embeds = 12 Modal SigLIP invocations. ~$0.01.
 * Wall: ~30s including Modal cold-start.
 *
 * Run (default: sweeps four crop fractions 0.45 / 0.50 / 0.55 / 0.62):
 *   node scripts/probe-art-crop-cosines.mjs
 *
 * Run (custom sweep):
 *   node scripts/probe-art-crop-cosines.mjs --crops=0.40,0.50,0.62
 *
 * Requires .env.local with: SUPABASE_URL, a Supabase key (anon is fine
 * for the public canonical_cards SELECTs), MODAL_SIGLIP_ENDPOINT_URL,
 * MODAL_SIGLIP_TOKEN.
 *
 * Pure .mjs (no TypeScript imports) so it runs on any Node >= 20 — no
 * loader required. The artCropTransform implementation is inlined
 * (parametrized over the top-fraction); the lib version at 0.62 is the
 * v1 recipe. If a tighter crop wins the sweep and we ship it, the lib
 * needs the new fraction + ART_CROP_RECIPE_VERSION bump in lockstep.
 *
 * Cost per run: ~6 source fetches + (1 EN + 6 JP) embeds per crop.
 * Default 4-crop sweep = 28 Modal calls (~$0.05) + first-call cold
 * start (~10s). Subsequent crops run warm.
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

// `override: true` is required when the user has previously sourced
// .env.local into their shell — dotenv otherwise leaves stale (often
// empty) shell values in place. The 90-var "injecting" line is no
// proof a specific var got set; only override guarantees it.
dotenv.config({ path: ".env.local", override: true });

// Art-crop transform, inlined verbatim from lib/ai/image-crops.ts.
// Inlining avoids the TS loader so this probe runs on the default
// Node binary the user already has (no --experimental-strip-types).
// The probe parametrizes the top-fraction so we can sweep crop
// tightness in one session. lib/ai/image-crops.ts uses 0.62 as the
// v1 recipe — anything we ship to prod must match that value, or
// change the recipe version there in lockstep.
const ART_CROP_MAX_EDGE_PX = 800;

async function artCropTransform(input, topFraction) {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("source image has no dimensions");
  if (width < 200 || height < 200) {
    throw new Error(`source image too small to crop: ${width}x${height}`);
  }
  const cropHeight = Math.max(1, Math.round(height * topFraction));
  return sharp(input)
    .extract({ left: 0, top: 0, width, height: cropHeight })
    .resize({
      width: ART_CROP_MAX_EDGE_PX,
      height: ART_CROP_MAX_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

// CLI args: --crops=0.45,0.50,0.62  (default sweeps the three).
function parseCrops(argv) {
  for (const a of argv.slice(2)) {
    if (a.startsWith("--crops=")) {
      const list = a.slice("--crops=".length)
        .split(",")
        .map((s) => Number.parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 1);
      if (list.length > 0) return list;
    }
  }
  // Default sweep: tight (illustration-only) → standard (lib default).
  return [0.45, 0.50, 0.55, 0.62];
}

// Modal SigLIP embedder, inlined.
//
// We can't import lib/ai/image-embedder.ts via the strip-only TS loader
// because that file uses TypeScript parameter properties
// (`constructor(message: string, public readonly cause?: unknown)`),
// which Node's --experimental-strip-types doesn't transform. The Modal
// embed call is a small HTTP POST — re-implementing here is simpler
// than refactoring the lib file. Behavior matches ModalSiglipEmbedder
// exactly: same endpoint, same auth body shape, same data URI input.
// Resolve Modal credentials with name fallbacks. Vercel's "Sensitive"
// flag causes `env pull` to return empty for protected vars; the user
// then has to paste the token under whatever name they've adopted.
function resolveModalEndpoint() {
  return (
    process.env.MODAL_SIGLIP_ENDPOINT_URL?.trim() ||
    process.env.MODAL_SIGLIP_URL?.trim() ||
    process.env.MODAL_ENDPOINT_URL?.trim() ||
    process.env.MODAL_INFERENCE_URL?.trim() ||
    process.env.MODAL_INFERENCE_ENDPOINT_URL?.trim() ||
    null
  );
}
function resolveModalToken() {
  return (
    process.env.MODAL_SIGLIP_TOKEN?.trim() ||
    process.env.MODAL_TOKEN?.trim() ||
    process.env.MODAL_INFERENCE_TOKEN?.trim() ||
    process.env.MODAL_API_TOKEN?.trim() ||
    null
  );
}

async function embedBytesViaModal(bytes, mimeType) {
  const endpoint = resolveModalEndpoint();
  const token = resolveModalToken();
  if (!endpoint || !token) {
    console.error("Modal endpoint or token missing. Found:");
    for (const k of Object.keys(process.env).filter((k) => /MODAL/i.test(k)).sort()) {
      console.error(`  ${k} length=${(process.env[k] ?? "").length}`);
    }
    throw new Error("MODAL endpoint or token not set");
  }
  const dataUri = `data:${mimeType};base64,${bytes.toString("base64")}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: token, inputs: dataUri }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Modal endpoint ${resp.status}: ${errBody.slice(0, 400)}`);
  }
  const parsed = await resp.json();
  const item = parsed?.results?.[0];
  if (!item?.embedding) {
    throw new Error(`Modal embed failed: ${item?.error ?? "no embedding in response"}`);
  }
  return item.embedding;
}

// EN reference is fixed across all pairs so we compute the EN art-crop
// embedding ONCE and re-use it. JP varies per row.
const EN_REFERENCE_SLUG = "base-set-2-4-charizard";

const PAIRS = [
  // ── Baseline: same-language same-art. Should be VERY high (>=0.90)
  //    if the crop+embed pipeline is working at all. If this is low,
  //    something's wrong with the crop function or the embedder.
  {
    label: "SAME_ART (same-lang sanity baseline)",
    jp: "evolutions-11-charizard",          // EN, same Arita art
    expectHigh: true,
    note: "EN<->EN reprint of identical Arita illustration. Sanity check.",
  },

  // ── SAME ART, cross-language. The hypothesis predicts these will
  //    jump from ~0.78 full-card to ~0.92 art-crop.
  {
    label: "SAME_ART (cross-language)",
    jp: "expansion-pack-6-charizard-jp",     // JP, original 1996 Arita
    expectHigh: true,
    note: "EN Base Set Charizard vs JP Expansion Pack #6 -- same 1996 Mitsuhiro Arita art across language.",
  },

  // ── DIFFERENT ART, same Pokemon, cross-language. Should be LOW
  //    if the hypothesis holds. Today these score 0.75-0.80 on the
  //    full card; we expect art-crop to drop them substantially.
  {
    label: "DIFFERENT_ART (modern JP 151)",
    jp: "pokemon-card-151-185-charizard-ex-jp",
    expectHigh: false,
    note: "Modern 151 set Charizard ex SAR illustration -- different art entirely.",
  },
  {
    label: "DIFFERENT_ART (DP-era JP)",
    jp: "advent-of-arceus-17-charizard-jp",
    expectHigh: false,
    note: "DP-era Charizard, different illustrator/style.",
  },
  {
    label: "DIFFERENT_ART (e-Card-era JP)",
    jp: "shining-darkness-6-charizard-jp",
    expectHigh: false,
    note: "e-Card era Charizard, different art.",
  },
  {
    label: "DIFFERENT_ART (1995 Topsun)",
    jp: "topsun-6-charizard-jp",
    expectHigh: false,
    note: "1995 Topsun promo -- the OLDEST Pokemon card. Definitely different art.",
  },
];

function resolvePostgresUrl() {
  const names = ["POSTGRES_URL", "PopAlpha_POSTGRES_URL", "POPALPHA_POSTGRES_URL", "POSTGRES_URL_NON_POOLING"];
  for (const name of names) {
    const raw = process.env[name]?.trim().replace(/^["']|["']$/g, "");
    if (raw) {
      process.env.POSTGRES_URL = raw;
      return raw;
    }
  }
  console.error(`No Postgres URL found; tried ${names.join(", ")}`);
  process.exit(2);
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`Missing ${name}`); process.exit(2); }
  return v;
}

function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function fetchImageBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const arr = new Uint8Array(await resp.arrayBuffer());
  return Buffer.from(arr);
}

// Fetch the slug's source image bytes once. We embed it multiple
// times per crop-sweep run, so isolating the fetch keeps Modal as the
// only repeated cost across crops.
async function fetchSourceBytes(supabase, slug) {
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, language, mirrored_primary_image_url, primary_image_url")
    .eq("slug", slug)
    .limit(1);
  if (error) throw new Error(`canonical_cards lookup for ${slug}: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) throw new Error(`slug not found: ${slug}`);
  const url = row.mirrored_primary_image_url ?? row.primary_image_url;
  if (!url) throw new Error(`no image URL for ${slug}`);
  const src = await fetchImageBuffer(url);
  return { row, src, url };
}

async function embedAtCrop(srcBytes, topFraction) {
  const cropped = await artCropTransform(srcBytes, topFraction);
  const embedding = await embedBytesViaModal(cropped, "image/jpeg");
  return { embedding, croppedBytes: cropped.length };
}

async function main() {
  const crops = parseCrops(process.argv);
  resolvePostgresUrl();
  // This probe only does SELECTs against canonical_cards
  // (mirrored_primary_image_url is public catalog data — same trust
  // tier the iOS app reads). Service-role isn't required; fall back
  // to anon / publishable on environments where `vercel env pull`
  // returns empty for "Sensitive" keys.
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseKey) {
    console.error("No usable Supabase key — tried SERVICE_ROLE, SECRET, ANON, PUBLISHABLE.");
    process.exit(2);
  }
  const supabase = createClient(requireEnv("SUPABASE_URL"), supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  console.log(`embedder: Modal SigLIP-2 (siglip2-base-patch16-384-v1, 768-d)`);
  console.log(`crop sweep: top-fractions = [${crops.join(", ")}]`);
  console.log("");

  // Fetch every source image ONCE. Crop+embed runs per crop value below.
  console.log("Fetching source images…");
  const enSrc = await fetchSourceBytes(supabase, EN_REFERENCE_SLUG);
  console.log(`  EN ref ${EN_REFERENCE_SLUG} -> ${enSrc.src.length}B`);
  const jpSrcs = [];
  for (const pair of PAIRS) {
    try {
      const s = await fetchSourceBytes(supabase, pair.jp);
      jpSrcs.push({ pair, src: s.src, url: s.url });
      console.log(`  ${pair.jp.padEnd(50)} -> ${s.src.length}B`);
    } catch (err) {
      console.log(`  ${pair.jp.padEnd(50)} -> ERROR: ${err?.message ?? err}`);
      jpSrcs.push({ pair, src: null, error: err?.message ?? String(err) });
    }
  }
  console.log("");

  // Sweep crops. For each crop, embed EN ref + each JP, compute cosines.
  const sweepSummaries = [];
  for (const crop of crops) {
    console.log(`══════════════════════════════════════════════════════════════════════════`);
    console.log(`  crop top-fraction = ${crop}`);
    console.log(`══════════════════════════════════════════════════════════════════════════`);
    let enEmb;
    try {
      const r = await embedAtCrop(enSrc.src, crop);
      enEmb = r.embedding;
      console.log(`  EN ref cropped=${r.croppedBytes}B, embedded.`);
    } catch (err) {
      console.log(`  EN ref FAILED at crop=${crop}: ${err?.message ?? err}`);
      continue;
    }
    console.log("  cosine   expect   label                                  jp_slug");
    console.log("  ───────────────────────────────────────────────────────────────────");

    const results = [];
    for (const j of jpSrcs) {
      if (!j.src) {
        console.log(`  ERROR    -        ${j.pair.label.padEnd(38)}  ${j.pair.jp} :: source fetch failed`);
        continue;
      }
      try {
        const r = await embedAtCrop(j.src, crop);
        const cos = cosine(enEmb, r.embedding);
        results.push({ ...j.pair, cosine: cos });
        const expectStr = j.pair.expectHigh ? "HIGH " : "low  ";
        console.log(`  ${cos.toFixed(4)}   ${expectStr}   ${j.pair.label.padEnd(38)}  ${j.pair.jp}`);
      } catch (err) {
        console.log(`  ERROR    -        ${j.pair.label.padEnd(38)}  ${j.pair.jp} :: ${err?.message ?? err}`);
        results.push({ ...j.pair, cosine: null, error: err?.message ?? String(err) });
      }
    }

    // Per-crop summary
    const same = results.filter((r) => r.expectHigh && r.cosine != null);
    const diff = results.filter((r) => !r.expectHigh && r.cosine != null);
    // Use the cross-language same-art floor (skip the same-language baseline)
    // when computing margin — the baseline always wins by a large margin and
    // dilutes the signal we actually care about.
    const sameXLang = same.filter((r) => r.label?.includes("cross-language"));
    const minSameXLang = sameXLang.length ? Math.min(...sameXLang.map((r) => r.cosine)) : null;
    const maxDiff = diff.length ? Math.max(...diff.map((r) => r.cosine)) : null;
    const margin = (minSameXLang != null && maxDiff != null) ? minSameXLang - maxDiff : null;
    sweepSummaries.push({ crop, minSameXLang, maxDiff, margin });
    console.log("  ───────────────────────────────────────────────────────────────────");
    console.log(`  min(SAME_ART cross-lang) = ${minSameXLang?.toFixed(4) ?? "n/a"}`);
    console.log(`  max(DIFFERENT_ART)       = ${maxDiff?.toFixed(4) ?? "n/a"}`);
    console.log(`  margin                   = ${margin != null ? margin.toFixed(4) : "n/a"}`);
    console.log("");
  }

  // Final sweep table
  console.log("═══════════ Crop sweep summary ═══════════");
  console.log("crop   minSameXLang   maxDiff    margin");
  for (const s of sweepSummaries) {
    console.log(
      `${s.crop.toFixed(2)}   ${s.minSameXLang?.toFixed(4) ?? "  n/a "}      ${s.maxDiff?.toFixed(4) ?? "  n/a "}    ${s.margin != null ? s.margin.toFixed(4) : "  n/a "}`,
    );
  }
  console.log("");

  const best = sweepSummaries
    .filter((s) => s.margin != null)
    .sort((a, b) => b.margin - a.margin)[0];
  if (!best) {
    console.log("VERDICT: no crop produced usable signal. Pivot.");
    return;
  }
  if (best.margin >= 0.08 && best.minSameXLang >= 0.88) {
    console.log(`VERDICT: drain validated at crop=${best.crop}. margin=${best.margin.toFixed(4)} is healthy, cross-lang same-art clears ${best.minSameXLang.toFixed(4)}. Proceed with full drain using top-fraction=${best.crop}.`);
  } else if (best.margin >= 0.05) {
    console.log(`VERDICT: best crop=${best.crop} (margin=${best.margin.toFixed(4)}) is borderline. Layered signals (top-1-with-margin + name) likely needed even with this crop.`);
  } else {
    console.log(`VERDICT: even tightest crop margin is thin (${best.margin.toFixed(4)} at crop=${best.crop}). Cosine alone won't deliver. Pivot to layered signals.`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
