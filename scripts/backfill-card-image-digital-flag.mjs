#!/usr/bin/env node
// Backfill card_image_embeddings.is_digital_only for existing rows.
//
// Context: TCG Pocket cards (Pokemon's digital-only mobile game) were
// originally ingested into the reference embedding index alongside
// physical Pokemon TCG cards. First eval run surfaced that those
// digital cards compete for kNN matches against real user scans of
// physical cards — half the wrong top-1 matches in the 12-scan
// baseline were to TCG Pocket cards (Cramorant→Pidgey, Lopunny→
// Lucario ex, etc.). Filtering them out of the kNN should push
// top-1 accuracy up materially without any augmentation changes.
//
// This script is the one-time backfill needed because TCG Pocket
// rows that landed BEFORE the is_digital_only column existed default
// to `false`. Cross-DB: digital detection needs canonical_cards
// (Supabase) but the UPDATE target is card_image_embeddings (Neon),
// so we resolve digital slugs in Supabase first, then push the list
// as a parameter to Neon's UPDATE.
//
// Idempotent: reruns just re-UPDATE rows that are already true.
//
// Usage:
//   npm run scan:backfill-digital
//   npm run scan:backfill-digital -- --dry-run
//
// Requires:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — for the canonical_cards read
//   PopAlpha_POSTGRES_URL or POSTGRES_URL — for the Neon UPDATE

import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");

function requireEnv(name, fallbacks = []) {
  const candidates = [name, ...fallbacks];
  for (const candidate of candidates) {
    const value = process.env[candidate]?.trim();
    if (value) return value;
  }
  console.error(`Missing required env var: ${candidates.join(" or ")}`);
  process.exit(2);
}

function resolvePostgresUrl() {
  const names = [
    "POSTGRES_URL",
    "PopAlpha_POSTGRES_URL",
    "POPALPHA_POSTGRES_URL",
    "AI_NEON_DATABASE_URL",
    "POPALPHA_NEON_DATABASE_URL",
    "NEON_DATABASE_URL",
    "POSTGRES_URL_NON_POOLING",
  ];
  for (const name of names) {
    const value = process.env[name]?.trim().replace(/^["']|["']$/g, "");
    if (value) {
      process.env.POSTGRES_URL = value;
      return value;
    }
  }
  console.error(`No Neon Postgres URL found; tried ${names.join(", ")}`);
  process.exit(2);
}

async function main() {
  resolvePostgresUrl();

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  // 1. Collect all digital-only slugs from Supabase.
  const digitalSlugs = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug")
      .like("primary_image_url", "%/pokemon/tcgp-%")
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error(`Supabase select failed: ${error.message}`);
      process.exit(1);
    }
    const rows = data ?? [];
    for (const row of rows) digitalSlugs.push(row.slug);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`Found ${digitalSlugs.length} TCG Pocket (digital-only) slugs in canonical_cards.`);

  if (digitalSlugs.length === 0) {
    console.log("Nothing to backfill.");
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log("DRY RUN — first 10 digital slugs:");
    for (const slug of digitalSlugs.slice(0, 10)) console.log(`  - ${slug}`);
    console.log("Would UPDATE card_image_embeddings SET is_digital_only=true WHERE canonical_slug IN (<above list>)");
    process.exit(0);
  }

  // 2. Bulk-update Neon. Single query, array param — safe for ~2.5k
  // slugs and keeps the round-trip to one.
  const { sql } = await import("@vercel/postgres");
  const result = await sql.query(
    `
      update card_image_embeddings
      set is_digital_only = true,
          updated_at = now()
      where canonical_slug = any($1::text[])
        and is_digital_only = false
    `,
    [digitalSlugs],
  );

  console.log(`Updated ${result.rowCount ?? 0} rows in card_image_embeddings.`);

  // Sanity check.
  const after = await sql.query(
    `select count(*)::int as n from card_image_embeddings where is_digital_only = true`,
  );
  console.log(`Total is_digital_only=true rows after backfill: ${after.rows[0]?.n ?? 0}`);
}

main().catch((err) => {
  console.error("Fatal:", err?.stack ?? err);
  process.exit(1);
});
