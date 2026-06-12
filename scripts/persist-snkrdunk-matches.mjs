#!/usr/bin/env node
/**
 * Step C of the Snkrdunk catalog-mapper sequence.
 *
 * Reads the JSONL produced by Step B (scripts/match-snkrdunk-canonical.mjs)
 * or the offline re-scorer (scripts/rescore-snkrdunk-jsonl.mjs) and upserts
 * mapping rows into public.snkrdunk_product_map. Step D's orchestrator then
 * reads the MATCHED rows to know which Snkrdunk products to fetch prices for.
 *
 * Status mapping (Step B's scorer → DB):
 *   "matched"        → mapping_status='MATCHED'         (auto-imported)
 *   "needs-review"   → mapping_status='NEEDS_REVIEW'    (gated for operator)
 *   "low-confidence" → skipped (don't pollute the table with rejects)
 *   "no-tc-results"  → skipped
 *   "no-query"       → skipped
 *   "search-failed"  → skipped (transient error; re-run Step B to retry)
 *
 * Idempotent re-persist rules (2026-06 recall batch; previously the script
 * blind-upserted on canonical_slug and silently dropped product-code
 * collisions — the 2026-05-14 seeding run lost 337 of 8,123 rows that way):
 *
 *   1. Operator-reviewed rows (reviewed_at set) are immutable unless
 *      --force-status (unchanged from PR #55 v3).
 *   2. REJECTED rows are immutable (defensive; normally caught by rule 1).
 *   3. Existing MATCHED rows are NEVER touched — no downgrade, no product
 *      code swap, no score refresh. Code changes for MATCHED rows are an
 *      operator review task (the re-scorer lists them; nothing auto-writes).
 *   4. Existing NEEDS_REVIEW rows are upgraded only when the incoming row
 *      is MATCHED (status improvement); NR→NR re-writes are skipped.
 *   5. Within one input file, if two canonical_slugs claim the same
 *      snkrdunk_product_code, the higher score wins (tie: better number
 *      match via numberMatchRank; then slug order for determinism). The
 *      loser is persisted as NEEDS_REVIEW with a conflict note appended to
 *      match_reasons instead of being silently dropped.
 *   6. If an incoming MATCHED row's product code is already owned by a
 *      DIFFERENT slug's MATCHED row in the DB, the incoming row is demoted
 *      to NEEDS_REVIEW with a conflict note (the existing MATCHED row wins
 *      by rule 3).
 *
 * Rules 5/6 require the partial unique index migration
 * (snkrdunk_product_map_product_code_matched_uidx — uniqueness enforced for
 * MATCHED rows only) so demoted NEEDS_REVIEW rows can share a product code
 * with the winner. Run after that migration is applied.
 *
 * Usage:
 *   # Dry-run on the smoke-test JSONL (no credentials required; DB-dependent
 *   # guards are reported as unknown when credentials are absent)
 *   node scripts/persist-snkrdunk-matches.mjs --input=/tmp/snkr-match-batch.jsonl --dry-run
 *
 *   # Real import (default reads the standard output path)
 *   node scripts/persist-snkrdunk-matches.mjs
 *
 *   # Include needs-review rows (default writes them too, gated by status)
 *   node scripts/persist-snkrdunk-matches.mjs --matched-only   # opt out of needs-review
 */

import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const DEFAULT_INPUT = "tmp/snkrdunk-canonical-matches.jsonl";

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    input: DEFAULT_INPUT,
    dryRun: false,
    matchedOnly: false,
    forceStatus: false,
    quiet: false,
  };
  for (const a of args) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--matched-only") opts.matchedOnly = true;
    else if (a === "--force-status") opts.forceStatus = true;
    else if (a === "--quiet") opts.quiet = true;
  }
  return opts;
}

function statusToDb(status) {
  switch (status) {
    case "matched":
      return "MATCHED";
    case "needs-review":
      return "NEEDS_REVIEW";
    default:
      return null; // skip
  }
}

// =============================================================================
// Pure decision helpers (exported for scripts/__smoke__/snkrdunk-persist-conflicts.mjs)
// =============================================================================

/**
 * Rank the number-match quality from a scorer reasons array:
 * 2 = exact, 1 = normalized, 0 = none. Conflict tie-break per the 2026-06
 * recall spec: equal scores → better number match wins the product code.
 */
export function numberMatchRank(reasons) {
  const rs = Array.isArray(reasons) ? reasons : [];
  if (rs.some((r) => typeof r === "string" && r.includes("number-exact"))) return 2;
  if (rs.some((r) => typeof r === "string" && r.includes("number-normalized"))) return 1;
  return 0;
}

/**
 * Resolve within-input product-code collisions.
 *
 * entries: [{ canonical_slug, best: { snkrdunk_product_code, score, reasons } }]
 * Returns Map<canonical_slug, { winnerSlug, winnerScore }> for every LOSER —
 * callers demote those entries to NEEDS_REVIEW with a conflict note.
 * Winner = highest score; tie → numberMatchRank; tie → slug sort order
 * (deterministic across re-runs).
 */
export function resolveProductCodeConflicts(entries) {
  const byCode = new Map();
  for (const e of entries) {
    const code = e?.best?.snkrdunk_product_code;
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(e);
  }
  const demotions = new Map();
  for (const group of byCode.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) =>
        (b.best.score ?? 0) - (a.best.score ?? 0) ||
        numberMatchRank(b.best.reasons) - numberMatchRank(a.best.reasons) ||
        String(a.canonical_slug).localeCompare(String(b.canonical_slug)),
    );
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      demotions.set(loser.canonical_slug, {
        winnerSlug: winner.canonical_slug,
        winnerScore: winner.best.score ?? 0,
      });
    }
  }
  return demotions;
}

/**
 * Decide what to do with an incoming row given the existing DB row for the
 * same canonical_slug. See the idempotent re-persist rules in the header.
 *
 * existing: { mapping_status, reviewed_at } | null | undefined
 * incomingStatus: 'MATCHED' | 'NEEDS_REVIEW'
 * Returns { action: 'write' | 'skip', why }.
 */
export function decideWrite(existing, incomingStatus, opts = {}) {
  if (!existing) return { action: "write", why: "new-row" };
  if (opts.forceStatus) return { action: "write", why: "force-status" };
  if (existing.reviewed_at) return { action: "skip", why: "reviewed-immutable" };
  if (existing.mapping_status === "REJECTED") return { action: "skip", why: "rejected-immutable" };
  if (existing.mapping_status === "MATCHED") return { action: "skip", why: "matched-immutable" };
  if (incomingStatus === "MATCHED") return { action: "write", why: "upgrade-nr-to-matched" };
  return { action: "skip", why: "no-improvement" };
}

// =============================================================================
// Main
// =============================================================================

async function loadExistingMap(supabase) {
  const PAGE = 1000;
  const bySlug = new Map();
  const matchedCodeOwner = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("snkrdunk_product_map")
      .select("canonical_slug, snkrdunk_product_code, mapping_status, reviewed_at")
      .order("canonical_slug", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loading existing snkrdunk_product_map: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      bySlug.set(row.canonical_slug, row);
      if (row.mapping_status === "MATCHED") {
        matchedCodeOwner.set(row.snkrdunk_product_code, row.canonical_slug);
      }
    }
    if (data.length < PAGE) break;
  }
  return { bySlug, matchedCodeOwner };
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = (...args) => opts.quiet || console.log("[persist-snkrdunk]", ...args);

  const inputPath = resolve(opts.input);
  if (!existsSync(inputPath)) {
    console.error(`[persist-snkrdunk] input not found: ${inputPath}`);
    console.error("Run scripts/match-snkrdunk-canonical.mjs first to produce the JSONL.");
    process.exit(1);
  }

  // Defer Supabase client creation until we actually need DB access —
  // dry-run should work without service-role credentials. Codex P2 on PR #55.
  let supabase = null;
  const hasCreds = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const getSupabase = () => {
    if (supabase) return supabase;
    if (!hasCreds) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for real writes (use --dry-run to preview without credentials)",
      );
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabase;
  };

  const rows = [];
  for (const line of readFileSync(inputPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      console.warn(`[persist-snkrdunk] skipping corrupt JSONL line: ${err.message}`);
    }
  }
  log(`loaded ${rows.length} JSONL row(s) from ${inputPath}`);

  // ---------------------------------------------------------------------------
  // Pass 1: filter to persistable rows and resolve within-input product-code
  // collisions BEFORE any write, so the loser demotion is deterministic and
  // independent of input order.
  // ---------------------------------------------------------------------------
  let skipped = 0;
  const entries = [];
  const seenSlugs = new Set();
  for (const row of rows) {
    const dbStatus = statusToDb(row.status);
    if (!dbStatus || !row.best) {
      skipped += 1;
      continue;
    }
    if (opts.matchedOnly && dbStatus !== "MATCHED") {
      skipped += 1;
      continue;
    }
    if (seenSlugs.has(row.canonical_slug)) {
      // Resume-mode JSONLs can carry duplicate slugs; first occurrence wins
      // (matches the matcher's own resume semantics).
      skipped += 1;
      continue;
    }
    seenSlugs.add(row.canonical_slug);
    entries.push({
      canonical_slug: row.canonical_slug,
      best: row.best,
      query: row.query ?? null,
      dbStatus,
      conflictNote: null,
    });
  }

  const demotions = resolveProductCodeConflicts(entries);
  let conflictDemotedBatch = 0;
  for (const e of entries) {
    const d = demotions.get(e.canonical_slug);
    if (!d) continue;
    conflictDemotedBatch += 1;
    e.dbStatus = "NEEDS_REVIEW";
    e.conflictNote = `conflict-demoted: ${e.best.snkrdunk_product_code} also claimed by ${d.winnerSlug} (score ${(d.winnerScore ?? 0).toFixed(2)} vs ${(e.best.score ?? 0).toFixed(2)})`;
  }

  // ---------------------------------------------------------------------------
  // Pass 2: load the existing map once (when credentials allow), then apply
  // the idempotent re-persist rules row by row.
  // ---------------------------------------------------------------------------
  let existingMap = { bySlug: new Map(), matchedCodeOwner: new Map() };
  let dbStateKnown = false;
  if (hasCreds) {
    existingMap = await loadExistingMap(getSupabase());
    dbStateKnown = true;
    log(`existing map: ${existingMap.bySlug.size} row(s), ${existingMap.matchedCodeOwner.size} MATCHED code owner(s)`);
  } else if (opts.dryRun) {
    log("dry-run without credentials — existing-row guards reported as unknown");
  }

  let matched = 0;
  let needsReview = 0;
  let written = 0;
  let upgrades = 0;
  let conflictDemotedDb = 0;
  let reviewedPreserved = 0;
  let rejectedPreserved = 0;
  let matchedImmutable = 0;
  let noImprovement = 0;
  let conflicts = 0;
  let writeErrors = 0;

  for (const e of entries) {
    // DB-level cross-slug code conflict: an incoming MATCHED row whose code
    // is owned by a DIFFERENT slug's MATCHED row demotes to NEEDS_REVIEW
    // (rule 6) — the existing MATCHED row is immutable by rule 3.
    if (dbStateKnown && e.dbStatus === "MATCHED") {
      const owner = existingMap.matchedCodeOwner.get(e.best.snkrdunk_product_code);
      if (owner && owner !== e.canonical_slug) {
        conflictDemotedDb += 1;
        e.dbStatus = "NEEDS_REVIEW";
        e.conflictNote = `conflict-demoted: ${e.best.snkrdunk_product_code} already MATCHED to ${owner} in snkrdunk_product_map`;
      }
    }

    if (e.dbStatus === "MATCHED") matched += 1;
    if (e.dbStatus === "NEEDS_REVIEW") needsReview += 1;

    const existing = existingMap.bySlug.get(e.canonical_slug) ?? null;
    const decision = decideWrite(existing, e.dbStatus, { forceStatus: opts.forceStatus });

    if (decision.action === "skip") {
      if (decision.why === "reviewed-immutable") reviewedPreserved += 1;
      else if (decision.why === "rejected-immutable") rejectedPreserved += 1;
      else if (decision.why === "matched-immutable") matchedImmutable += 1;
      else noImprovement += 1;
      continue;
    }

    const reasons = Array.isArray(e.best.reasons) ? [...e.best.reasons] : [];
    if (e.conflictNote) reasons.push(e.conflictNote);

    const dbRow = {
      canonical_slug: e.canonical_slug,
      snkrdunk_id: e.best.snkrdunk_id,
      snkrdunk_product_code: e.best.snkrdunk_product_code,
      snkrdunk_name: e.best.name,
      match_score: e.best.score,
      match_reasons: reasons.length > 0 ? reasons : null,
      match_query: e.query,
      mapping_status: e.dbStatus,
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (opts.dryRun) {
      const guard = dbStateKnown ? decision.why : `${decision.why}?`;
      log(`  [dry] ${e.dbStatus.padEnd(13)} ${dbRow.canonical_slug.slice(0, 50).padEnd(50)} → ${dbRow.snkrdunk_product_code}  score=${dbRow.match_score?.toFixed(2)}  (${guard}${e.conflictNote ? "; conflict-demoted" : ""})`);
      written += 1;
      if (decision.why === "upgrade-nr-to-matched") upgrades += 1;
      continue;
    }

    const { error } = await getSupabase()
      .from("snkrdunk_product_map")
      .upsert(dbRow, { onConflict: "canonical_slug" });
    if (error) {
      // Last-resort guard: the partial unique index on MATCHED product codes
      // can still fire on concurrent writers. Log + skip; re-run is safe.
      if (error.code === "23505" || /unique/i.test(error.message)) {
        console.warn(`[persist-snkrdunk] CONFLICT for ${dbRow.canonical_slug} → ${dbRow.snkrdunk_product_code}: ${error.message}`);
        conflicts += 1;
        continue;
      }
      console.error(`[persist-snkrdunk] WRITE ERROR for ${dbRow.canonical_slug}: ${error.message}`);
      writeErrors += 1;
      continue;
    }
    written += 1;
    if (decision.why === "upgrade-nr-to-matched") upgrades += 1;
    if (dbStateKnown && dbRow.mapping_status === "MATCHED") {
      existingMap.matchedCodeOwner.set(dbRow.snkrdunk_product_code, dbRow.canonical_slug);
    }
  }

  console.log("");
  console.log("[persist-snkrdunk] DONE");
  console.log(`  loaded:                  ${rows.length}`);
  console.log(`  matched:                 ${matched}${opts.dryRun ? " (dry-run)" : ""}`);
  console.log(`  needs-review:            ${needsReview}${opts.dryRun ? " (dry-run)" : ""}`);
  console.log(`  written:                 ${written}${opts.dryRun ? " (dry-run skipped writes)" : ""}`);
  console.log(`  nr→matched upgrades:     ${upgrades}`);
  console.log(`  conflict-demoted (input):${conflictDemotedBatch}`);
  console.log(`  conflict-demoted (db):   ${conflictDemotedDb}`);
  console.log(`  matched-immutable:       ${matchedImmutable}`);
  console.log(`  reviewed-preserved:      ${reviewedPreserved}${opts.forceStatus ? " (force-status mode disabled this guard)" : ""}`);
  console.log(`  rejected-preserved:      ${rejectedPreserved}`);
  console.log(`  nr no-improvement:       ${noImprovement}`);
  console.log(`  conflicts (23505):       ${conflicts}`);
  console.log(`  write-errors:            ${writeErrors}`);
  console.log(`  skipped:                 ${skipped}`);

  if (writeErrors > 0) process.exit(1);
}

// Only auto-run when invoked as a CLI; allow imports for the smoke harness.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[persist-snkrdunk] FATAL:", err);
    process.exit(1);
  });
}
