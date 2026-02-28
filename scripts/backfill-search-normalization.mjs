/**
 * Backfill normalized search fields for canonical card search.
 *
 * Safe production flow:
 * 1. Apply the search migrations.
 * 2. Run `node scripts/backfill-search-normalization.mjs`.
 * 3. Re-running is safe; only rows whose normalized fields changed are written.
 *
 * Flags:
 * - `--dry-run`: compute changes and print totals without writing.
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { buildCanonicalSearchDoc, normalizeSearchText } from "../lib/search/normalize.mjs";

const PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 250;

function getSupabase() {
  dotenv.config({ path: ".env.local" });
  dotenv.config();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

export async function fetchAllPages(label, buildQuery, pageSize = PAGE_SIZE) {
  const rows = [];
  let from = 0;
  let page = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) throw error;

    const batch = data ?? [];
    page += 1;
    rows.push(...batch);

    console.log(
      JSON.stringify({
        phase: "fetch",
        label,
        page,
        from,
        to,
        rows: batch.length,
        totalSoFar: rows.length,
      }),
    );

    if (batch.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return rows;
}

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  return {
    dryRun: flags.has("--dry-run"),
  };
}

function toCanonicalUpdate(row, primaryImageBySlug) {
  const searchDoc = buildCanonicalSearchDoc(row);
  const nextSearchDocNorm = normalizeSearchText(searchDoc);
  const nextPrimaryImageUrl = primaryImageBySlug.get(row.slug) ?? null;

  const changed =
    (row.search_doc ?? "") !== searchDoc ||
    (row.search_doc_norm ?? "") !== nextSearchDocNorm ||
    (row.primary_image_url ?? null) !== nextPrimaryImageUrl;

  if (!changed) return null;

  return {
    slug: row.slug,
    canonical_name: row.canonical_name,
    subject: row.subject,
    set_name: row.set_name,
    year: row.year,
    card_number: row.card_number,
    language: row.language,
    variant: row.variant,
    search_doc: searchDoc,
    search_doc_norm: nextSearchDocNorm,
    primary_image_url: nextPrimaryImageUrl,
  };
}

function toAliasUpdate(row) {
  const nextAliasNorm = normalizeSearchText(row.alias);
  if ((row.alias_norm ?? "") === nextAliasNorm) return null;

  return {
    alias: row.alias,
    canonical_slug: row.canonical_slug,
    alias_norm: nextAliasNorm,
  };
}

async function writeBatches({ supabase, table, rows, onConflict, dryRun }) {
  if (rows.length === 0) {
    console.log(JSON.stringify({ phase: "write", table, batches: 0, updated: 0, dryRun }));
    return;
  }

  let batchNumber = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH_SIZE) {
    const batch = rows.slice(i, i + WRITE_BATCH_SIZE);
    batchNumber += 1;

    console.log(
      JSON.stringify({
        phase: "write",
        table,
        batch: batchNumber,
        batchSize: batch.length,
        updatedSoFar: Math.min(i + batch.length, rows.length),
        totalToUpdate: rows.length,
        dryRun,
      }),
    );

    if (dryRun) continue;

    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw error;
  }
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const supabase = getSupabase();

  const [canonicalRows, aliasRows, printingRows] = await Promise.all([
    fetchAllPages("canonical_cards", () =>
      supabase
        .from("canonical_cards")
        .select(
          "slug, canonical_name, subject, set_name, year, card_number, language, variant, search_doc, search_doc_norm, primary_image_url",
        ),
    ),
    fetchAllPages("card_aliases", () =>
      supabase
        .from("card_aliases")
        .select("alias, canonical_slug, alias_norm"),
    ),
    fetchAllPages("card_printings", () =>
      supabase
        .from("card_printings")
        .select("canonical_slug, image_url")
        .not("image_url", "is", null)
        .order("canonical_slug", { ascending: true })
        .order("id", { ascending: true }),
    ),
  ]);

  const primaryImageBySlug = new Map();
  for (const row of printingRows) {
    if (!row.image_url || primaryImageBySlug.has(row.canonical_slug)) continue;
    primaryImageBySlug.set(row.canonical_slug, row.image_url);
  }

  const canonicalUpdates = canonicalRows
    .map((row) => toCanonicalUpdate(row, primaryImageBySlug))
    .filter((row) => row !== null);

  const aliasUpdates = aliasRows
    .map((row) => toAliasUpdate(row))
    .filter((row) => row !== null);

  await writeBatches({
    supabase,
    table: "canonical_cards",
    rows: canonicalUpdates,
    onConflict: "slug",
    dryRun,
  });

  await writeBatches({
    supabase,
    table: "card_aliases",
    rows: aliasUpdates,
    onConflict: "alias,canonical_slug",
    dryRun,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        canonicalRowsScanned: canonicalRows.length,
        aliasRowsScanned: aliasRows.length,
        printingRowsScanned: printingRows.length,
        canonicalRowsUpdated: canonicalUpdates.length,
        aliasRowsUpdated: aliasUpdates.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
    } else {
      try {
        console.error(JSON.stringify(error, null, 2));
      } catch {
        console.error(String(error));
      }
    }
    process.exit(1);
  });
}
