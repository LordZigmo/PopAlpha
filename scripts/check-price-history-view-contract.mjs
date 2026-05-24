import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const REQUIRED_CONTRACTS = [
  {
    view: "public_price_history_canonical",
    fragments: [
      "ph.source_window = 'snapshot'",
      "ph.currency = 'USD'",
      "ph.variant_ref like '%::RAW'",
      "ph.variant_ref not ilike '%::GRADED::%'",
      "split_part(ph.variant_ref, '::', 1)::uuid = ph.printing_id",
      "ph.printing_id = public.preferred_canonical_raw_printing(ph.canonical_slug)",
    ],
  },
  {
    view: "public_price_history_by_printing",
    fragments: [
      "ph.source_window = 'snapshot'",
      "ph.currency = 'USD'",
      "ph.variant_ref like '%::RAW'",
      "ph.variant_ref not ilike '%::GRADED::%'",
      "split_part(ph.variant_ref, '::', 1)::uuid = ph.printing_id",
    ],
  },
  {
    view: "public_card_metrics",
    fragments: [
      "raw_market_price_outlier",
      "outlier_suppressed",
      "base_cm.market_price >",
      "base_cm.snapshot_count_30d",
    ],
  },
];

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function latestViewDefinition(viewName) {
  const needle = `create or replace view public.${viewName}`;
  const files = listMigrationFiles();
  for (const filename of files.toReversed()) {
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    const content = fs.readFileSync(fullPath, "utf8");
    const normalized = content.toLowerCase();
    if (normalized.includes(needle)) {
      return { filename, content: normalized };
    }
  }
  return null;
}

const violations = [];
for (const contract of REQUIRED_CONTRACTS) {
  const definition = latestViewDefinition(contract.view);
  if (!definition) {
    violations.push(`${contract.view}: no create-or-replace definition found`);
    continue;
  }
  for (const fragment of contract.fragments) {
    if (!definition.content.includes(fragment.toLowerCase())) {
      violations.push(`${contract.view}: ${definition.filename} is missing "${fragment}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("price-history view contract FAILED:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("price-history view contract passed");
