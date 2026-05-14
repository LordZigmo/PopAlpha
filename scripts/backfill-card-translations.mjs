#!/usr/bin/env node
/**
 * backfill-card-translations
 *
 * Populates public.card_translations with EN <-> JP pairings derived
 * from SigLIP image-embedding cosine similarity, gated by the
 * EN_TO_JP_POKEMON name glossary from lib/jp/matcher.mjs.
 *
 * Algorithm per EN canonical card with an active-variant embedding:
 *   1. Pull its full-crop embedding vector from card_image_embeddings.
 *   2. kNN top-8 against card_image_embeddings rows where language='JP'
 *      and model_version matches the active SigLIP variant.
 *   3. For each candidate, apply the JP-name glossary gate (loose
 *      contains on canonical_cards.canonical_name_native) when both
 *      sides have native names. If neither side has native names, fall
 *      back to a higher cosine threshold so we don't pair on art alone.
 *   4. card_number string equality bumps the score as a tiebreak.
 *   5. Top candidate with cosine ≥ MIN_PRIMARY_COSINE writes rank=0;
 *      next 1–2 alternates with cosine ≥ MIN_ALT_COSINE write rank≥1.
 *   6. ON CONFLICT (en_slug, jp_slug) DO UPDATE — idempotent re-runs.
 *
 * The card_image_embeddings table lives in Supabase (NOT Neon — the
 * /Users/popalpha/.../scanner-runbook.md memory captures the
 * one-DB-only architecture). Connection string resolves through
 * POSTGRES_URL the same way the scan-identify route does.
 *
 * Usage:
 *   # Process every EN canonical_card that has an active-variant embedding:
 *   node scripts/backfill-card-translations.mjs
 *
 *   # Smoke test on a single slug:
 *   node scripts/backfill-card-translations.mjs --slug=base-set-2-charizard
 *
 *   # Bounded run with a dry-run preview:
 *   node scripts/backfill-card-translations.mjs --limit=50 --dry-run
 *
 *   # Resume from a known watermark slug (next run picks up at slug > X):
 *   node scripts/backfill-card-translations.mjs --resume-from=base-set-2-charizard
 *
 *   # Tune thresholds (defaults: 0.90 / 0.85):
 *   node scripts/backfill-card-translations.mjs --min-cosine=0.92 --alt-cosine=0.87
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { EN_TO_JP_POKEMON } from "../lib/jp/matcher.mjs";

dotenv.config({ path: ".env.local" });

const DEFAULTS = {
  minPrimaryCosine: 0.90,
  minAltCosine: 0.85,
  // Used when neither side has canonical_name_native — name-glossary
  // gate can't apply, so demand stronger visual agreement.
  noGlossaryFloorCosine: 0.94,
  topK: 8,
  batchSize: 200,
  altRankMax: 2,
};

function parseArgs(argv) {
  const opts = {
    slug: null,
    limit: null,
    resumeFrom: null,
    minCosine: DEFAULTS.minPrimaryCosine,
    altCosine: DEFAULTS.minAltCosine,
    dryRun: false,
    verbose: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--slug=")) opts.slug = arg.slice("--slug=".length);
    else if (arg.startsWith("--limit=")) opts.limit = Math.max(1, Number.parseInt(arg.slice("--limit=".length), 10) || 1);
    else if (arg.startsWith("--resume-from=")) opts.resumeFrom = arg.slice("--resume-from=".length);
    else if (arg.startsWith("--min-cosine=")) opts.minCosine = Number.parseFloat(arg.slice("--min-cosine=".length)) || DEFAULTS.minPrimaryCosine;
    else if (arg.startsWith("--alt-cosine=")) opts.altCosine = Number.parseFloat(arg.slice("--alt-cosine=".length)) || DEFAULTS.minAltCosine;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: backfill-card-translations.mjs [--slug=X] [--limit=N] [--resume-from=SLUG] [--min-cosine=0.90] [--alt-cosine=0.85] [--dry-run]");
      process.exit(0);
    }
  }
  return opts;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

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

/**
 * Returns the active SigLIP model version that card_image_embeddings is
 * indexed with. Mirrors lib/ai/image-embedder.ts resolveActiveModelVersion.
 *
 * We hardcode the SigLIP tag here rather than import the TS module so
 * the script stays runnable as a pure ESM mjs without ts-node.
 */
function resolveActiveModelVersion() {
  const variant = (process.env.IMAGE_EMBEDDER_VARIANT ?? "").toLowerCase();
  if (variant === "modal-siglip") return "siglip2-base-patch16-384-v1";
  // Default flipped to SigLIP on 2026-05-07; check the env first in case
  // the operator forced CLIP back on.
  if (variant === "replicate-clip" || variant === "clip") return "replicate-clip-vit-l-14-v1";
  return "siglip2-base-patch16-384-v1";
}

/**
 * Loose JP-name match: returns true when the EN card's expected JP
 * rendering (from EN_TO_JP_POKEMON) appears anywhere in the JP
 * candidate's canonical_name_native. Returns null when either side
 * has no native name to compare — caller decides the policy.
 */
function nameGlossaryGate(enCard, jpCard) {
  const enBase = (enCard.canonical_name ?? "").trim().toLowerCase();
  // Some EN cards have prefixes/suffixes ("Radiant Charizard", "Charizard ex").
  // Try the full name first, then split off the base species.
  const enBaseSpecies = enBase.split(/\s+/)[0];
  const expectedJp = EN_TO_JP_POKEMON[enBase] ?? EN_TO_JP_POKEMON[enBaseSpecies] ?? null;
  const jpNative = (jpCard.canonical_name_native ?? "").trim();
  if (!jpNative) return null;          // JP side lacks native — caller decides
  if (!expectedJp) return null;        // No glossary entry — caller decides
  return jpNative.includes(expectedJp);
}

function cardNumberMatch(enCard, jpCard) {
  const a = String(enCard.card_number ?? "").trim();
  const b = String(jpCard.card_number ?? "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // Strip leading zeros and any "/total" suffix.
  const norm = (s) => s.split("/")[0].replace(/^0+(?=\d)/, "").trim();
  return norm(a) === norm(b);
}

async function loadEnCandidates(supabase, opts, modelVersion) {
  if (opts.slug) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, canonical_name_native, set_name, card_number, language, image_embedded_model_version")
      .eq("slug", opts.slug)
      .limit(1);
    if (error) throw new Error(`canonical_cards: ${error.message}`);
    return (data ?? []).filter((r) => r.language === "EN" && r.image_embedded_model_version === modelVersion);
  }
  const PAGE = 1000;
  const rows = [];
  let cursor = opts.resumeFrom ?? null;
  while (true) {
    let q = supabase
      .from("canonical_cards")
      .select("slug, canonical_name, canonical_name_native, set_name, card_number, language, image_embedded_model_version")
      .eq("language", "EN")
      .eq("image_embedded_model_version", modelVersion)
      .order("slug", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("slug", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`canonical_cards page: ${error.message}`);
    const page = data ?? [];
    if (page.length === 0) break;
    rows.push(...page);
    cursor = page[page.length - 1].slug;
    if (opts.limit && rows.length >= opts.limit) {
      return rows.slice(0, opts.limit);
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Run the kNN query for one EN slug. Pulls top-K JP rows by cosine
 * distance against the EN slug's full-crop embedding. Hydrates each
 * JP row with canonical_name_native from canonical_cards so the
 * glossary gate has something to read.
 *
 * Two-query design: the kNN returns canonical_slug + cos_dist; the
 * follow-up canonical_cards lookup adds canonical_name_native /
 * card_number. Avoids a JOIN against canonical_cards inside the kNN
 * (which would defeat the HNSW index).
 */
async function findJpCandidates({ sql, supabase }, enSlug, modelVersion, topK) {
  const knn = await sql.query(
    `
      with en_vec as (
        select embedding
          from card_image_embeddings
         where canonical_slug = $1
           and model_version = $2
           and variant_index = 0
           and crop_type = 'full'
         limit 1
      )
      select e.canonical_slug,
             (e.embedding <=> (select embedding from en_vec)) as cos_dist
        from card_image_embeddings e
       where e.model_version = $2
         and e.language = 'JP'
         and e.is_digital_only = false
         and e.crop_type = 'full'
         and e.variant_index = 0
         and exists (select 1 from en_vec)
       order by e.embedding <=> (select embedding from en_vec)
       limit $3
    `,
    [enSlug, modelVersion, topK],
  );
  const candidates = (knn.rows ?? []).map((r) => ({
    jp_slug: r.canonical_slug,
    cos_dist: Number(r.cos_dist),
    cosine: 1 - Number(r.cos_dist),
  }));
  if (candidates.length === 0) return [];

  const slugs = candidates.map((c) => c.jp_slug);
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, canonical_name_native, set_name, card_number, language")
    .in("slug", slugs);
  if (error) throw new Error(`hydrate JP candidates: ${error.message}`);
  const bySlug = new Map((data ?? []).map((r) => [r.slug, r]));
  return candidates
    .map((c) => ({ ...c, card: bySlug.get(c.jp_slug) ?? null }))
    .filter((c) => c.card && c.card.language === "JP");
}

function pickPairings(enCard, candidates, opts) {
  // Score each candidate. Cosine is the dominant signal; number match
  // adds a small bump that breaks near-ties.
  const scored = candidates
    .map((c) => {
      const numberBoost = cardNumberMatch(enCard, c.card) ? 0.02 : 0;
      return { ...c, score: c.cosine + numberBoost };
    })
    .sort((a, b) => b.score - a.score);

  const accepted = [];
  for (const cand of scored) {
    const gate = nameGlossaryGate(enCard, cand.card);
    const cosine = cand.cosine;
    let qualifies;
    if (gate === true) {
      qualifies = cosine >= opts.altCosine;
    } else if (gate === false) {
      // Glossary says these aren't the same Pokemon — skip even if cosine is high.
      continue;
    } else {
      // gate === null: no glossary signal. Require stronger visual match.
      qualifies = cosine >= DEFAULTS.noGlossaryFloorCosine;
    }
    if (!qualifies) continue;
    accepted.push(cand);
    if (accepted.length > opts.altRankMax + 1) break;
  }

  if (accepted.length === 0) return [];
  // Primary must clear the cosine floor on its own merits — NOT the
  // score (cosine + numberBoost). The boost is a tiebreak for ordering
  // among candidates that already cleared the cosine bar; promoting a
  // sub-threshold-cosine candidate to rank=0 just because its
  // numberBoost lifted its score above a real 0.91 candidate would
  // surface an unsafe pairing in the EN/JP toggle. `accepted` is
  // sorted by score; find() walks in that order, so the chosen
  // primary is the highest-score candidate that ALSO meets the raw
  // cosine bar. Candidates with higher score but lower cosine drop
  // into the alts bucket if their cosine still clears altCosine
  // (they did clear it — they're in `accepted`).
  const primary = accepted.find((c) => c.cosine >= opts.minCosine);
  if (!primary) return [];
  const alts = accepted.filter((c) => c !== primary).slice(0, opts.altRankMax);
  const rows = [
    { jp_slug: primary.card.slug, confidence: primary.cosine, rank: 0 },
  ];
  alts.forEach((a, i) => {
    rows.push({ jp_slug: a.card.slug, confidence: a.cosine, rank: i + 1 });
  });
  return rows;
}

async function upsertPairings({ sql }, enSlug, pairings) {
  if (pairings.length === 0) return 0;
  // Delete-then-insert pattern. Plain ON CONFLICT (en_slug, jp_slug)
  // isn't sufficient because a rerun where the rank=0 pairing flips
  // to a different jp_slug would leave the OLD rank=0 row in place
  // (ON CONFLICT doesn't fire across different jp_slug values),
  // producing two rank=0 rows. The detail endpoint reads
  // .eq("rank", 0).maybeSingle() and would error on the duplicate,
  // hiding the toggle entirely. Wiping rows for the en_slug first
  // makes the new pairing set the source of truth.
  //
  // Targeted DELETE (where jp_slug not in new set) would preserve
  // unchanged rows, but DELETE-all is simpler and the immediate
  // INSERT keeps the gap small. A crash between the two leaves the
  // EN slug temporarily unpaired; the next cron pass re-pairs it.
  const newJpSlugs = pairings.map((p) => p.jp_slug);
  await sql.query(
    `delete from card_translations where en_slug = $1 and jp_slug <> all($2::text[])`,
    [enSlug, newJpSlugs],
  );

  // Multi-row insert with positional params. $1 is shared (enSlug);
  // each pairing consumes three sequential params (jp_slug, confidence,
  // rank). Source + updated_at are literal in the VALUES list.
  const valuesSql = pairings
    .map((_, i) =>
      `($1::text, $${i * 3 + 2}::text, $${i * 3 + 3}::real, $${i * 3 + 4}::smallint, 'image_embedding_v1'::text, now())`,
    )
    .join(", ");
  const params = [enSlug];
  for (const p of pairings) {
    params.push(p.jp_slug, p.confidence, p.rank);
  }
  const result = await sql.query(
    `
      insert into card_translations
        (en_slug, jp_slug, confidence, rank, source, updated_at)
      select * from (values ${valuesSql}) as v(en_slug, jp_slug, confidence, rank, source, updated_at)
      on conflict (en_slug, jp_slug) do update
        set confidence = excluded.confidence,
            rank       = excluded.rank,
            source     = excluded.source,
            updated_at = now()
    `,
    params,
  );
  return result.rowCount ?? 0;
}

async function main() {
  const opts = parseArgs(process.argv);
  resolvePostgresUrl();
  const { sql } = await import("@vercel/postgres");
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const modelVersion = resolveActiveModelVersion();
  console.log(`[backfill-card-translations] active model_version: ${modelVersion}`);
  console.log(`[backfill-card-translations] thresholds: primary>=${opts.minCosine} alt>=${opts.altCosine} no-glossary-floor=${DEFAULTS.noGlossaryFloorCosine}`);
  if (opts.dryRun) console.log(`[backfill-card-translations] DRY RUN — no writes`);

  const enCards = await loadEnCandidates(supabase, opts, modelVersion);
  console.log(`[backfill-card-translations] EN candidates: ${enCards.length}`);
  if (enCards.length === 0) {
    console.log("[backfill-card-translations] nothing to do — exiting");
    return;
  }

  let processed = 0;
  let withPrimary = 0;
  let withAlts = 0;
  let writtenRows = 0;
  let lastSlug = null;
  // Track every slug we attempt so the cron's NOT-NULL-NULLS-FIRST
  // ordering can move past them in subsequent runs. Stamped in a
  // batched UPDATE at the end of this run — see the post-loop block.
  // Skipped in dry-run mode so a smoke-test pass doesn't burn the
  // 14-day retry window for slugs we never actually wrote.
  const attemptedSlugs = [];
  const started = Date.now();

  for (const enCard of enCards) {
    processed += 1;
    lastSlug = enCard.slug;
    if (!opts.dryRun) attemptedSlugs.push(enCard.slug);
    try {
      const candidates = await findJpCandidates({ sql, supabase }, enCard.slug, modelVersion, DEFAULTS.topK);
      if (candidates.length === 0) {
        if (opts.verbose) console.log(`[${processed}] ${enCard.slug} — no JP candidates`);
        continue;
      }
      const pairings = pickPairings(enCard, candidates, opts);
      if (pairings.length === 0) {
        if (opts.verbose) {
          const top = candidates[0];
          console.log(`[${processed}] ${enCard.slug} — top cosine=${top.cosine.toFixed(4)} (${top.card?.canonical_name}) didn't qualify`);
        }
        continue;
      }
      const primary = pairings.find((p) => p.rank === 0);
      if (primary) withPrimary += 1;
      if (pairings.some((p) => p.rank > 0)) withAlts += 1;
      if (opts.verbose || opts.dryRun) {
        const preview = pairings
          .map((p) => `rank=${p.rank} jp=${p.jp_slug} cos=${p.confidence.toFixed(4)}`)
          .join(" | ");
        console.log(`[${processed}] ${enCard.slug} -> ${preview}`);
      }
      if (!opts.dryRun) {
        const rows = await upsertPairings({ sql }, enCard.slug, pairings);
        writtenRows += rows;
      }
    } catch (err) {
      console.error(`[${processed}] ${enCard.slug} — ERROR: ${err?.message ?? err}`);
    }

    if (processed % 50 === 0) {
      const sec = (Date.now() - started) / 1000;
      const rate = processed / Math.max(0.1, sec);
      const remaining = enCards.length - processed;
      const eta = remaining / Math.max(0.001, rate);
      console.log(`[backfill-card-translations] ${processed}/${enCards.length}  primary=${withPrimary} alts=${withAlts} wrote=${writtenRows}  ${rate.toFixed(2)} card/s  ETA ${(eta / 60).toFixed(1)}min  last=${lastSlug}`);
    }
  }

  // Batch-stamp translation_attempted_at on every slug we touched.
  // Skipped under --dry-run. The cron's candidate selection orders by
  // (translation_attempted_at ASC NULLS FIRST), so stamping during a
  // bulk backfill correctly pushes processed slugs to the back of the
  // line, letting the weekly cron focus on never-tried EN slugs first
  // and only revisit these once 14 days have elapsed.
  if (!opts.dryRun && attemptedSlugs.length > 0) {
    const stamp = await sql.query(
      `update canonical_cards set translation_attempted_at = now() where slug = any($1::text[])`,
      [attemptedSlugs],
    );
    console.log(`[backfill-card-translations] stamped translation_attempted_at on ${stamp.rowCount ?? 0} canonical_cards row(s)`);
  }

  const sec = (Date.now() - started) / 1000;
  console.log("");
  console.log(`[backfill-card-translations] DONE in ${sec.toFixed(1)}s`);
  console.log(`[backfill-card-translations] processed=${processed} primary_pairings=${withPrimary} with_alts=${withAlts} rows_written=${writtenRows}`);
  console.log(`[backfill-card-translations] last_slug=${lastSlug}`);
}

main().catch((err) => {
  console.error("[backfill-card-translations] FATAL:", err?.stack ?? err);
  process.exit(1);
});
