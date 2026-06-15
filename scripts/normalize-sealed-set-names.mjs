/**
 * Normalize SEALED-product set names to the canonical (card) set name.
 *
 * A historical sealed-products import stored canonical_cards.set_name with
 * provider code prefixes ("SV02: Paldea Evolved", "ME01: Mega Evolution",
 * "SWSH07: Evolving Skies", ...). Individual cards use the clean name
 * ("Paldea Evolved"), so every affected set fragmented into two names on
 * browse / set pages and showed inconsistent labels (the class of issue a
 * user flagged on X).
 *
 * This strips the "CODE: " prefix for variant='SEALED' rows AND rebuilds their
 * search_doc / search_doc_norm in the same write, so search and browse never
 * disagree (search_doc is JS-built, not a generated column/trigger).
 *
 * Safety:
 * - Only rows whose prefix-stripped name ALREADY exists as a non-SEALED set
 *   name are touched, so legitimate colon names ("Celebrations: Classic
 *   Collection", "TAG TEAM GX: Tag All Stars") are never altered. The EXISTS
 *   check — not the regex — is the load-bearing guard.
 * - Dry-run by default. Pass `--apply` to write. Prints the affected slugs so
 *   the change is reversible from the inventory.
 * - Idempotent: re-running is a no-op once prefixes are stripped.
 *
 * Usage:
 *   node scripts/normalize-sealed-set-names.mjs            # dry-run
 *   node scripts/normalize-sealed-set-names.mjs --apply    # write to prod
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildCanonicalSearchDoc, normalizeSearchText } from "../lib/search/normalize.mjs";

const WRITE_BATCH_SIZE = 250;
// Code prefix: letters + optional alphanumerics, then a colon and spaces, with
// no space before the colon ("SV02: ", "ME: "). Names like "Magma vs Aqua: …"
// (space before colon) never match.
const PREFIX_RE = /^[A-Za-z]+[0-9A-Za-z]*:\s*/;

function getSupabase() {
  dotenv.config({ path: ".env.local" });
  dotenv.config();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  const supabase = getSupabase();

  // 1. All sealed-product rows (small set — a few hundred).
  const { data: sealed, error: sealedErr } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number, language, variant, primary_image_url")
    .eq("variant", "SEALED");
  if (sealedErr) throw sealedErr;

  // 2. Distinct prefix-stripped names among prefixed sealed rows.
  const candidates = (sealed ?? []).filter((r) => r.set_name && PREFIX_RE.test(r.set_name));
  const strippedNames = [...new Set(candidates.map((r) => r.set_name.replace(PREFIX_RE, "")))];
  if (strippedNames.length === 0) {
    console.log(JSON.stringify({ phase: "done", affected: 0, note: "no prefixed sealed names", dryRun }));
    return;
  }

  // 3. Which stripped names actually exist as a non-SEALED (card) set name?
  const { data: cleanRows, error: cleanErr } = await supabase
    .from("canonical_cards")
    .select("set_name")
    .neq("variant", "SEALED")
    .in("set_name", strippedNames);
  if (cleanErr) throw cleanErr;
  const cleanSetNames = new Set((cleanRows ?? []).map((r) => r.set_name));

  // 4. Build the updates — only where a clean target exists.
  const updates = [];
  const bySet = {};
  for (const r of candidates) {
    const clean = r.set_name.replace(PREFIX_RE, "");
    if (!cleanSetNames.has(clean)) continue; // guard: skip if no clean counterpart
    const searchDoc = buildCanonicalSearchDoc({ ...r, set_name: clean });
    updates.push({
      slug: r.slug,
      canonical_name: r.canonical_name,
      subject: r.subject,
      set_name: clean,
      year: r.year,
      card_number: r.card_number,
      language: r.language,
      variant: r.variant,
      primary_image_url: r.primary_image_url,
      search_doc: searchDoc,
      search_doc_norm: normalizeSearchText(searchDoc),
    });
    const key = `${r.set_name} -> ${clean}`;
    bySet[key] = (bySet[key] ?? 0) + 1;
  }

  console.log(JSON.stringify({ phase: "plan", affected: updates.length, bySet, dryRun }, null, 2));

  // 5. Write in batches (set_name + search_doc together).
  for (let i = 0; i < updates.length; i += WRITE_BATCH_SIZE) {
    const batch = updates.slice(i, i + WRITE_BATCH_SIZE);
    if (!dryRun) {
      const { error } = await supabase.from("canonical_cards").upsert(batch, { onConflict: "slug" });
      if (error) throw error;
    }
    console.log(
      JSON.stringify({
        phase: "write",
        wrote: dryRun ? 0 : batch.length,
        soFar: Math.min(i + batch.length, updates.length),
        total: updates.length,
        dryRun,
      }),
    );
  }

  console.log(
    JSON.stringify({ phase: "done", affected: updates.length, dryRun, slugs: updates.map((u) => u.slug) }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
