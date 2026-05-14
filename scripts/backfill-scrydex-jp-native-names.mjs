#!/usr/bin/env node
/**
 * Backfill canonical_cards.canonical_name_native + set_name_native for
 * all JP cards by re-fetching from the Scrydex /ja/ catalog and stamping
 * the original Japanese names that the canonical importer threw away.
 *
 * Background: import-scrydex-canonical-direct.mjs prioritizes the
 * English translation for canonical_name + set_name because every
 * downstream code path (search index, scanner OCR, matcher, alias table)
 * assumes Latin-character text. This is the right default for those code
 * paths, but it left us without the raw Japanese needed by:
 *   - The Yahoo! Auctions JP / Snkrdunk / Mercari JP scraper (precision
 *     query construction)
 *   - The /internal/admin/jp-explorer view + scripts/jp-gloss.mjs CLI
 *     for English-speaking operator ergonomics
 *
 * This script is non-destructive:
 *   - Only writes to the new canonical_name_native + set_name_native
 *     columns (added by 20260508120000_canonical_cards_native_names.sql).
 *   - Skips any row where canonical_name_native is already populated
 *     (idempotent re-runs).
 *   - Reads from Scrydex /ja/ exactly the way the canonical importer
 *     does — same auth, same paging, same rate limits.
 *
 * Pre-requisite: 20260508120000_canonical_cards_native_names.sql must be
 * applied. Script will error fast if the columns don't exist.
 *
 * Usage:
 *   node scripts/backfill-scrydex-jp-native-names.mjs              # all JP sets
 *   node scripts/backfill-scrydex-jp-native-names.mjs --set-codes=base1_ja,neo1_ja
 *   node scripts/backfill-scrydex-jp-native-names.mjs --dry-run    # show first 20, don't write
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const SCRYDEX_BASE_URL = "https://api.scrydex.com/pokemon/v1";
const DEFAULT_PAGE_SIZE = 100;
const UPDATE_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 1200;

dotenv.config({ path: ".env.local" });

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, setCodes: [] };
  for (const arg of args) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--set-codes=")) {
      opts.setCodes = arg.slice("--set-codes=".length).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

// Mirrors slugify in import-scrydex-canonical-direct.mjs so we can
// regenerate slugs and compare. See that file for the rationale.
function slugify(input) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 200);
}

function parseCardNumber(rawNumber) {
  const trimmed = String(rawNumber ?? "").trim();
  const slashMatch = trimmed.match(/^#?\s*(\d+)\s*\/\s*\d+/i);
  if (slashMatch) return slashMatch[1];
  const numberMatch = trimmed.match(/^#?\s*(\d+)/);
  return numberMatch ? numberMatch[1] : trimmed;
}

function deriveCardNumberFromProviderId(providerId) {
  if (!providerId) return "";
  const tail = String(providerId).split(/[-_]/).pop() ?? "";
  const numeric = tail.replace(/[^0-9]/g, "");
  if (numeric) return numeric;
  return tail.replace(/[^A-Za-z0-9]/g, "") || "";
}

async function fetchScrydexJson(path, params, credentials) {
  const url = `${SCRYDEX_BASE_URL}${path}?${params.toString()}`;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "X-Api-Key": credentials.apiKey, "X-Team-ID": credentials.teamId },
        cache: "no-store",
        signal: controller.signal,
      });
      if (res.ok) {
        clearTimeout(timeoutId);
        return res.json();
      }
      const body = (await res.text()).slice(0, 400);
      lastError = `HTTP ${res.status}: ${body}`;
      clearTimeout(timeoutId);
      if (attempt >= MAX_RETRY_ATTEMPTS) break;
      await sleep(RETRY_BACKOFF_MS * attempt);
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_RETRY_ATTEMPTS) break;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error(lastError ?? "Scrydex fetch failed");
}

async function fetchAllJpExpansions(credentials) {
  const expansions = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ page: String(page), page_size: String(DEFAULT_PAGE_SIZE) });
    const payload = await fetchScrydexJson("/ja/expansions", params, credentials);
    const rows = payload.data ?? [];
    expansions.push(...rows);
    if (rows.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
    await sleep(200);
  }
  return expansions;
}

async function fetchAllCardsForExpansion(credentials, expansionId) {
  const cards = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ page: String(page), page_size: String(DEFAULT_PAGE_SIZE) });
    const payload = await fetchScrydexJson(
      `/ja/expansions/${encodeURIComponent(expansionId)}/cards`,
      params,
      credentials,
    );
    const rows = payload.data ?? [];
    cards.push(...rows);
    if (rows.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
    await sleep(200);
  }
  return cards;
}

/**
 * Build the canonical slug exactly the way the import script does, so we
 * match existing rows. See toPreparedCard in import-scrydex-canonical-direct.mjs.
 */
function deriveCanonicalSlug(card) {
  const enTranslation = card.translation?.en ?? null;
  const enExpansion = card.expansion?.translation?.en ?? null;
  const cardName = enTranslation?.name?.trim() || card.name?.trim() || "";
  const setName = enExpansion?.name?.trim() || card.expansion?.name?.trim() || null;
  const rawNumber = (card.number ?? card.printed_number ?? "").trim();
  let parsedNumber = parseCardNumber(rawNumber);
  if (!parsedNumber) parsedNumber = deriveCardNumberFromProviderId(card.id);
  return slugify(`${setName ?? "unknown-set"}-${parsedNumber}-${cardName}-jp`)
    || slugify(`${card.id}-jp`);
}

async function main() {
  const args = parseArgs(process.argv);
  const credentials = {
    apiKey: requireEnv("SCRYDEX_API_KEY"),
    teamId: requireEnv("SCRYDEX_TEAM_ID"),
  };
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Fail fast if the migration hasn't been applied yet.
  const { error: probeErr } = await supabase
    .from("canonical_cards")
    .select("canonical_name_native")
    .limit(1);
  if (probeErr) {
    console.error("[backfill-jp-native-names] schema check failed — is the migration 20260508120000 applied?");
    console.error("  supabase error:", probeErr.message);
    process.exit(1);
  }

  console.log("[backfill-jp-native-names] loading expansions from Scrydex /ja...");
  const allExpansions = await fetchAllJpExpansions(credentials);
  let targetExpansions = allExpansions.filter((e) => e.id && e.is_online_only !== true);
  if (args.setCodes.length > 0) {
    const wanted = new Set(args.setCodes);
    targetExpansions = targetExpansions.filter((e) => wanted.has(String(e.id).trim()));
  }
  console.log(`[backfill-jp-native-names] ${targetExpansions.length} JP expansions to process`);

  let totalCardsSeen = 0;
  let totalUpdates = 0;
  let totalSkippedAlreadySet = 0;
  let totalNotFound = 0;
  const samplePreview = [];

  for (const [idx, expansion] of targetExpansions.entries()) {
    const enExpansion = expansion.translation?.en ?? null;
    const setNameEn = enExpansion?.name?.trim() || null;
    const setNameNative = expansion.name?.trim() || null;
    if (!setNameNative) continue;

    console.log(`[backfill-jp-native-names] ${idx + 1}/${targetExpansions.length} ${expansion.id} ${setNameEn ?? "?"} ↔ ${setNameNative}`);

    const cards = await fetchAllCardsForExpansion(credentials, expansion.id);
    totalCardsSeen += cards.length;

    // Build slug → native name map
    const updates = [];
    for (const card of cards) {
      const slug = deriveCanonicalSlug(card);
      const nameNative = card.name?.trim() || null;
      if (!slug || !nameNative) continue;
      updates.push({ slug, canonical_name_native: nameNative, set_name_native: setNameNative });
    }

    if (args.dryRun) {
      samplePreview.push(...updates.slice(0, 3));
      continue;
    }

    // Filter to rows that actually exist and don't already have the native
    // name set, then UPDATE each. We can't use .upsert() here — PostgREST
    // turns it into INSERT ... ON CONFLICT DO UPDATE, and the INSERT side
    // requires all NOT NULL columns. Our payload doesn't include
    // canonical_name (NOT NULL) so the INSERT path fails with a not-null
    // violation even when ON CONFLICT would have routed to UPDATE.
    //
    // Per-row UPDATE is the right primitive: only touches the two new
    // columns, leaves canonical_name and everything else untouched.
    // Parallelized in small chunks to keep round-trip cost manageable
    // (~20k rows × 30ms ≈ 10 min sequential; 16 in parallel → ~40s).
    for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
      const chunk = updates.slice(i, i + UPDATE_BATCH_SIZE);
      const slugs = chunk.map((u) => u.slug);
      const { data: existing, error: existErr } = await supabase
        .from("canonical_cards")
        .select("slug, canonical_name_native")
        .in("slug", slugs);
      if (existErr) {
        console.error(`  fetch-existing failed: ${existErr.message}`);
        continue;
      }
      const existingBySlug = new Map(existing.map((r) => [r.slug, r]));

      const toApply = [];
      for (const u of chunk) {
        const ex = existingBySlug.get(u.slug);
        if (!ex) { totalNotFound += 1; continue; }
        if (ex.canonical_name_native) { totalSkippedAlreadySet += 1; continue; }
        toApply.push(u);
      }
      if (toApply.length === 0) continue;

      // Run per-row UPDATEs in small parallel chunks
      const PARALLEL = 16;
      let chunkUpdates = 0;
      for (let j = 0; j < toApply.length; j += PARALLEL) {
        const sub = toApply.slice(j, j + PARALLEL);
        const results = await Promise.all(
          sub.map(async (u) => {
            const { error } = await supabase
              .from("canonical_cards")
              .update({
                canonical_name_native: u.canonical_name_native,
                set_name_native: u.set_name_native,
              })
              .eq("slug", u.slug);
            if (error) {
              return { ok: false, slug: u.slug, err: error.message };
            }
            return { ok: true };
          }),
        );
        for (const r of results) {
          if (r.ok) chunkUpdates += 1;
          else console.error(`  update ${r.slug} failed: ${r.err}`);
        }
      }
      totalUpdates += chunkUpdates;
    }
    await sleep(150);
  }

  console.log("");
  if (args.dryRun) {
    console.log(`[backfill-jp-native-names] DRY-RUN: ${totalCardsSeen} cards seen across ${targetExpansions.length} expansions`);
    console.log(`[backfill-jp-native-names] sample preview (first 20):`);
    for (const s of samplePreview.slice(0, 20)) {
      console.log(`  ${s.slug}  ←  ${s.canonical_name_native} (${s.set_name_native})`);
    }
  } else {
    console.log(`[backfill-jp-native-names] DONE: cards seen=${totalCardsSeen} updated=${totalUpdates} skipped(already-set)=${totalSkippedAlreadySet} not-found-in-canonical=${totalNotFound}`);
  }
}

main().catch((err) => {
  console.error("[backfill-jp-native-names] FAILED:", err);
  process.exit(1);
});
