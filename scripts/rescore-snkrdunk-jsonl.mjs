#!/usr/bin/env node
/**
 * Offline re-scorer for the stored Snkrdunk forward-search JSONL.
 *
 * The production snkrdunk_product_map was seeded from ONE matcher run on
 * 2026-05-14 (tmp/snkrdunk-canonical-matches.jsonl, 14,974 rows). Two
 * generations of scoring improvements postdate that run:
 *   - 2026-05-15 symmetric era scoring (+0.15/-0.30) — commit 2415ad7
 *   - 2026-06 recall batch: L2 symmetric/variant-normalized name compare,
 *     L3 vintage number formats + setCode-only bracket parsing, L4 era-table
 *     gaps (neo/PRMF/VS/web/SC/CP/M), sister-set guard on single ambiguous
 *     set tokens
 *
 * This script re-scores the STORED candidates (top-5 per slug, as captured
 * by the original run — no network, no Snkrdunk calls) with the CURRENT
 * scoring and reports:
 *   - how many slugs would now be accepted (score >= MIN_MATCH_SCORE,
 *     reusing the matcher's exported threshold + classifyBest)
 *   - which fix unlocked each flip (re-scores under feature toggles)
 *   - how many existing MATCHED rows would CHANGE product code — these are
 *     listed for operator review and NEVER auto-written (--review-out)
 *   - a human-review sample of flips
 * and emits a JSONL of proposed new matches consumable by
 * scripts/persist-snkrdunk-matches.mjs (existing MATCHED + operator-reviewed
 * rows are excluded — persist's idempotency rules would skip them anyway;
 * excluding them keeps the proposed file equal to the actionable delta).
 *
 * Caveat: the stored JSONL keeps only the top-5 candidates per slug (by the
 * OLD score). A correct product that ranked 6th-20th on 2026-05-14 is not
 * recoverable offline — those slugs need a fresh search run.
 *
 * Inputs (all local files; no env, no network):
 *   --input   stored matcher JSONL   (default tmp/snkrdunk-canonical-matches.jsonl)
 *   --cards   JP canonical dump      (default tmp/jp-canonical-cards.jsonl)
 *   --map     snkrdunk_product_map dump (default tmp/snkrdunk-product-map-dump.jsonl)
 *   --out     proposed-matches JSONL (default tmp/snkrdunk-rescore-proposed.jsonl)
 *   --review-out  MATCHED-code-change review JSONL (default tmp/snkrdunk-rescore-review.jsonl)
 *   --sample  flip sample size printed for human review (default 20)
 *
 * Producing the dumps (READ-ONLY, psql against supabase/.temp/pooler-url
 * from the main checkout). Use `psql -At -c "..." > file` — NOT \copy:
 * COPY text format backslash-escapes the row_to_json output, so any value
 * with embedded quotes (every snkrdunk_name) silently fails JSON.parse.
 *   psql -At -c "select row_to_json(t) from (select slug, canonical_name,
 *     card_number, set_name, year, language from canonical_cards
 *     where language='JP') t" > tmp/jp-canonical-cards.jsonl
 *   psql -At -c "select row_to_json(t) from (select canonical_slug,
 *     snkrdunk_id, snkrdunk_product_code, snkrdunk_name, mapping_status,
 *     match_score, reviewed_at from snkrdunk_product_map) t"
 *     > tmp/snkrdunk-product-map-dump.jsonl
 *
 * Usage:
 *   node scripts/rescore-snkrdunk-jsonl.mjs
 *   node scripts/rescore-snkrdunk-jsonl.mjs --sample=40
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  scoreMatch,
  classifyBest,
  MIN_MATCH_SCORE,
} from "./match-snkrdunk-canonical.mjs";
import { parseSnkrdunkProductName } from "../lib/jp/snkrdunk-matcher.mjs";

function parseArgs(argv) {
  const opts = {
    input: "tmp/snkrdunk-canonical-matches.jsonl",
    cards: "tmp/jp-canonical-cards.jsonl",
    map: "tmp/snkrdunk-product-map-dump.jsonl",
    out: "tmp/snkrdunk-rescore-proposed.jsonl",
    reviewOut: "tmp/snkrdunk-rescore-review.jsonl",
    sample: 20,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a.startsWith("--cards=")) opts.cards = a.slice("--cards=".length);
    else if (a.startsWith("--map=")) opts.map = a.slice("--map=".length);
    else if (a.startsWith("--out=")) opts.out = a.slice("--out=".length);
    else if (a.startsWith("--review-out=")) opts.reviewOut = a.slice("--review-out=".length);
    else if (a.startsWith("--sample=")) opts.sample = Math.max(0, Number.parseInt(a.slice("--sample=".length), 10) || 0);
  }
  return opts;
}

function readJsonl(path, label) {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(`[rescore-snkrdunk] ${label} not found: ${abs}`);
    process.exit(1);
  }
  const rows = [];
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return rows;
}

/**
 * Score one slug's stored candidates under a scoring configuration.
 *   cfg.useStoredParsed — score against the 2026-05-14 parser output instead
 *                          of re-parsing with the current parser (the L3
 *                          bracket fix lives in the parser, so "L3 off"
 *                          means stored parse + legacy number comparator).
 *   cfg.features        — forwarded to scoreMatch ({ nameNorm, numForms,
 *                          eraAdditions }).
 * Returns candidates sorted by score desc (stable by original order).
 */
function scoreUnder(storedCandidates, card, cfg) {
  const scored = storedCandidates.map((c, idx) => {
    const parsed = cfg.useStoredParsed ? (c.parsed ?? null) : parseSnkrdunkProductName(c.name);
    const { score, reasons, setTokenHits } = scoreMatch({ parsed }, card, { features: cfg.features });
    return {
      snkrdunk_id: c.snkrdunk_id,
      snkrdunk_product_code: c.snkrdunk_product_code,
      name: c.name,
      parsed,
      score,
      reasons,
      setTokenHits,
      minPriceUsd: c.minPriceUsd ?? null,
      listingCount: c.listingCount ?? null,
      idx,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored;
}

const CONFIGS = {
  current: { useStoredParsed: false, features: { nameNorm: true, numForms: true, eraAdditions: true } },
  noL2: { useStoredParsed: false, features: { nameNorm: false, numForms: true, eraAdditions: true } },
  noL3: { useStoredParsed: true, features: { nameNorm: true, numForms: false, eraAdditions: true } },
  noL4: { useStoredParsed: false, features: { nameNorm: true, numForms: true, eraAdditions: false } },
  // Everything in this PR off + stored parse = main's scoring as of 2026-06
  // (which already includes the post-run 2026-05-15 era table + stopwords).
  baseline: { useStoredParsed: true, features: { nameNorm: false, numForms: false, eraAdditions: false } },
};

function eligible(best) {
  return Boolean(best) && best.score >= MIN_MATCH_SCORE;
}

function main() {
  const opts = parseArgs(process.argv);

  const inputRows = readJsonl(opts.input, "matcher JSONL");
  const cardRows = readJsonl(opts.cards, "canonical cards dump");
  const mapRows = readJsonl(opts.map, "product map dump");

  const cardsBySlug = new Map(cardRows.map((c) => [c.slug, c]));
  const mapBySlug = new Map(mapRows.map((m) => [m.canonical_slug, m]));

  console.log(`[rescore-snkrdunk] input rows:        ${inputRows.length}`);
  console.log(`[rescore-snkrdunk] canonical cards:   ${cardsBySlug.size}`);
  console.log(`[rescore-snkrdunk] existing map rows: ${mapBySlug.size}`);
  console.log(`[rescore-snkrdunk] threshold reused:  MIN_MATCH_SCORE=${MIN_MATCH_SCORE} + classifyBest (sister-set guard)`);
  console.log("");

  const counts = {
    noCandidates: 0,
    slugGone: 0,
    rescored: 0,
  };
  // old status → new status transition matrix
  const transitions = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  const flips = []; // newly eligible (old low-confidence → accepted)
  const nrToMatched = [];
  const matchedToNr = []; // sister-guard demotions of previously-matched rows
  const acceptedToLow = []; // previously accepted, now below threshold
  const matchedCodeChanges = []; // existing MATCHED map rows whose new best code differs
  const proposed = [];
  let guardDemotions = 0; // new status needs-review purely due to ambiguous single token
  let reviewedSkipped = 0;
  let matchedImmutableSkipped = 0;
  const attribution = new Map(); // category → count

  for (const row of inputRows) {
    const stored = Array.isArray(row.candidates) ? row.candidates : [];
    if (stored.length === 0) {
      counts.noCandidates += 1;
      continue;
    }
    const card = cardsBySlug.get(row.canonical_slug);
    if (!card) {
      counts.slugGone += 1;
      continue;
    }
    counts.rescored += 1;

    const cur = scoreUnder(stored, card, CONFIGS.current);
    const best = cur[0];
    const newStatus = classifyBest(best);
    const oldStatus = row.status ?? "unknown";
    bump(transitions, `${oldStatus} → ${newStatus}`);

    // Sister-guard demotion accounting: would have been "matched" pre-guard
    // (any set-token hit) but classify says needs-review.
    if (
      newStatus === "needs-review" &&
      Array.isArray(best.setTokenHits) &&
      best.setTokenHits.length > 0
    ) {
      guardDemotions += 1;
    }

    const newAccepted = newStatus === "matched" || newStatus === "needs-review";
    const oldAccepted = oldStatus === "matched" || oldStatus === "needs-review";

    // ----- fix attribution for newly-eligible slugs -----
    let attributionKey = null;
    if (!oldAccepted && newAccepted) {
      const necessary = [];
      for (const [fix, cfg] of [["l2-name", CONFIGS.noL2], ["l3-number", CONFIGS.noL3], ["l4-era", CONFIGS.noL4]]) {
        const alt = scoreUnder(stored, card, cfg);
        if (!eligible(alt[0])) necessary.push(fix);
      }
      if (necessary.length === 0) {
        const base = scoreUnder(stored, card, CONFIGS.baseline);
        attributionKey = eligible(base[0])
          ? "era-table-2026-05-15 (post-run main scoring)"
          : "fix-combination (no single fix necessary)";
      } else {
        attributionKey = necessary.join("+");
      }
      bump(attribution, attributionKey);
      flips.push({ row, card, best, newStatus, attributionKey });
    } else if (oldStatus === "needs-review" && newStatus === "matched") {
      nrToMatched.push({ row, best });
    } else if (oldStatus === "matched" && newStatus === "needs-review") {
      matchedToNr.push({ row, best });
    } else if (oldAccepted && !newAccepted) {
      acceptedToLow.push({ row, best });
    }

    // ----- existing-map comparison + proposed output -----
    const existing = mapBySlug.get(row.canonical_slug);
    if (existing?.reviewed_at) {
      reviewedSkipped += 1;
      continue; // operator rows are immutable — not in any output
    }
    if (existing?.mapping_status === "MATCHED") {
      if (newAccepted && best.snkrdunk_product_code !== existing.snkrdunk_product_code) {
        matchedCodeChanges.push({
          canonical_slug: row.canonical_slug,
          existing_code: existing.snkrdunk_product_code,
          existing_name: existing.snkrdunk_name ?? null,
          existing_score: existing.match_score ?? null,
          new_code: best.snkrdunk_product_code,
          new_name: best.name,
          new_score: best.score,
          new_status: newStatus,
          new_reasons: best.reasons,
        });
      }
      matchedImmutableSkipped += 1;
      continue; // never auto-update MATCHED rows
    }
    if (!newAccepted) continue;
    if (existing?.mapping_status === "NEEDS_REVIEW" && newStatus !== "matched") {
      continue; // persist would skip (no improvement) — keep the file actionable
    }
    proposed.push({
      canonical_slug: row.canonical_slug,
      query: row.query ?? null,
      candidates: cur.map(({ idx: _idx, ...c }) => c),
      best: (({ idx: _idx, ...c }) => c)(best),
      bestScore: best.score,
      status: newStatus,
      rescore: {
        source: "rescore-snkrdunk-jsonl",
        rescored_at: new Date().toISOString(),
        old_status: oldStatus,
        old_best_code: row.best?.snkrdunk_product_code ?? null,
        existing_map_status: existing?.mapping_status ?? null,
        attribution: attributionKey,
      },
    });
  }

  // ----- write outputs -----
  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, proposed.map((r) => JSON.stringify(r)).join("\n") + (proposed.length ? "\n" : ""));
  const reviewPath = resolve(opts.reviewOut);
  mkdirSync(dirname(reviewPath), { recursive: true });
  writeFileSync(
    reviewPath,
    matchedCodeChanges.map((r) => JSON.stringify(r)).join("\n") + (matchedCodeChanges.length ? "\n" : ""),
  );

  // ----- report -----
  const newMatched = flips.filter((f) => f.newStatus === "matched").length;
  const newNeedsReview = flips.filter((f) => f.newStatus === "needs-review").length;

  console.log("[rescore-snkrdunk] ---- coverage ----");
  console.log(`  rescored:                    ${counts.rescored}`);
  console.log(`  skipped (no candidates):     ${counts.noCandidates}`);
  console.log(`  skipped (slug gone from JP catalog): ${counts.slugGone}`);
  console.log("");
  console.log("[rescore-snkrdunk] ---- status transitions (old → new) ----");
  for (const [k, v] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
  console.log("");
  console.log("[rescore-snkrdunk] ---- newly eligible (old low-confidence → score >= threshold) ----");
  console.log(`  total:         ${flips.length}`);
  console.log(`    → matched:      ${newMatched}`);
  console.log(`    → needs-review: ${newNeedsReview}`);
  console.log("  by unlocking fix (fix necessary for eligibility):");
  for (const [k, v] of [...attribution.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log("");
  console.log("[rescore-snkrdunk] ---- other movements ----");
  console.log(`  needs-review → matched:            ${nrToMatched.length}`);
  console.log(`  matched → needs-review (guard):    ${matchedToNr.length}`);
  console.log(`  accepted → below threshold:        ${acceptedToLow.length}`);
  console.log(`  sister-guard demotions (new rows gated by ambiguous single token): ${guardDemotions}`);
  console.log("");
  console.log("[rescore-snkrdunk] ---- existing rows (immutable; informational) ----");
  console.log(`  operator-reviewed rows skipped:    ${reviewedSkipped}`);
  console.log(`  existing MATCHED rows skipped:     ${matchedImmutableSkipped}`);
  console.log(`  existing MATCHED rows whose new best CHANGES product code: ${matchedCodeChanges.length}`);
  console.log(`    → listed for operator review in ${reviewPath} (NOT auto-written)`);
  console.log("");
  console.log(`[rescore-snkrdunk] proposed new/upgraded rows for persist: ${proposed.length}`);
  console.log(`  → ${outPath}`);
  console.log("");

  if (opts.sample > 0 && flips.length > 0) {
    console.log(`[rescore-snkrdunk] ---- flip sample (${Math.min(opts.sample, flips.length)} of ${flips.length}, round-robin by fix) ----`);
    // Stratify across attribution categories so the sample shows each fix.
    const byCat = new Map();
    for (const f of flips) {
      if (!byCat.has(f.attributionKey)) byCat.set(f.attributionKey, []);
      byCat.get(f.attributionKey).push(f);
    }
    const cats = [...byCat.values()];
    const sample = [];
    for (let i = 0; sample.length < opts.sample; i += 1) {
      let pulled = false;
      for (const list of cats) {
        if (i < list.length && sample.length < opts.sample) {
          sample.push(list[i]);
          pulled = true;
        }
      }
      if (!pulled) break;
    }
    for (const f of sample) {
      console.log(`  ${f.row.canonical_slug}`);
      console.log(`     old: ${f.row.status} (best ${f.row.bestScore?.toFixed?.(2) ?? "n/a"})  →  new: ${f.newStatus} ${f.best.score.toFixed(2)}  [${f.attributionKey}]`);
      console.log(`     product: ${f.best.name}`);
      console.log(`     reasons: ${f.best.reasons.join(" ; ")}`);
    }
  }
}

main();
