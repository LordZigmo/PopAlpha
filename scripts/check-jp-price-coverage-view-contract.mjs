import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const REQUIRED_CONTRACT = {
  view: "public_jp_price_coverage",
  fragments: [
    "from public.canonical_cards cc",
    "left join public.public_card_metrics pcm",
    "left join public.yahoo_jp_card_prices yjp",
    "left join public.snkrdunk_card_prices snk",
    "cc.language = 'JP'",
    "coalesce(base.yahoo_jp_sample_count, 0) >= 3",
    "coalesce(base.snkrdunk_sample_count, 0) >= 3",
    "then 'snkrdunk'",
    "then 'yahoo_jp'",
    "display_price_source",
    "display_price_usd",
    "display_price_as_of",
    "covered_by_price",
    "grant select on public.public_jp_price_coverage to anon, authenticated",
  ],
};

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function latestViewDefinition(viewName) {
  // Recognize both CREATE OR REPLACE VIEW and DROP VIEW + plain CREATE VIEW. The
  // latter is required when a migration must drop a column from the view, which
  // CREATE OR REPLACE VIEW cannot do.
  const needles = [
    `create or replace view public.${viewName}`,
    `create view public.${viewName}`,
    // 20260615090000 converted the view to a MATERIALIZED view (same
    // name/body/grants) so per-slug lookups stop materializing the
    // full ~20.7k rows; the contract applies to its body identically.
    `create materialized view public.${viewName}`,
  ];
  for (const filename of listMigrationFiles().toReversed()) {
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    const content = fs.readFileSync(fullPath, "utf8");
    const normalized = content.toLowerCase();
    if (needles.some((needle) => normalized.includes(needle))) {
      return { filename, content: normalized };
    }
  }
  return null;
}

// pg_get_viewdef-sourced bodies (used by DROP+CREATE migrations) drop the
// `public.` schema qualifier that hand-written CREATE OR REPLACE bodies carry,
// so normalize it away on both sides before comparing fragments.
function stripSchema(text) {
  return text.replaceAll("public.", "");
}

const definition = latestViewDefinition(REQUIRED_CONTRACT.view);
const violations = [];

if (!definition) {
  violations.push(`${REQUIRED_CONTRACT.view}: no CREATE OR REPLACE VIEW definition found`);
} else {
  const haystack = stripSchema(definition.content);
  for (const fragment of REQUIRED_CONTRACT.fragments) {
    if (!haystack.includes(stripSchema(fragment.toLowerCase()))) {
      violations.push(`${REQUIRED_CONTRACT.view}: ${definition.filename} is missing "${fragment}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("JP price coverage view contract FAILED:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("JP price coverage view contract passed");
