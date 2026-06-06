import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const PUBLIC_VIEW_CONTRACTS = [
  {
    view: "public_set_summaries",
    source: "set_summary_snapshots",
  },
  {
    view: "public_set_finish_summary",
    source: "set_finish_summary_latest",
  },
];

const REQUIRED_SOURCE_CONTRACTS = [
  {
    label: "set_summary_snapshots table",
    marker: "create table if not exists public.set_summary_snapshots",
    fragments: [
      "market_cap",
      "market_cap_all_variants",
      "change_7d_pct",
      "change_30d_pct",
      "heat_score",
      "breakout_count",
      "value_zone_count",
      "trend_bullish_count",
      "sentiment_up_pct",
      "vote_count",
      "top_movers_json",
      "top_losers_json",
    ],
  },
  {
    label: "set_finish_summary_latest table",
    marker: "create table if not exists public.set_finish_summary_latest",
    fragments: [
      "finish",
      "market_cap",
      "card_count",
      "change_7d_pct",
      "change_30d_pct",
      "updated_at",
    ],
  },
  {
    label: "set summary refresh primary-variant contract",
    marker: "create or replace function public.refresh_set_summary_snapshots",
    fragments: [
      "case when l.finish = 'NON_HOLO' then 0 else 1 end",
      "l.observation_count_30d desc",
      "l.as_of_observed_at desc",
      "l.as_of_price desc",
      "jsonb_build_object",
      "'canonical_slug', pe.canonical_slug",
      "'change_7d_pct', pe.change_7d_pct_card",
      "limit 5",
    ],
  },
  {
    label: "set finish refresh contract",
    marker: "create or replace function public.refresh_set_finish_summary_latest",
    fragments: [
      "coalesce(vpl.finish, 'UNKNOWN') as finish",
      "count(distinct vpl.canonical_slug) as card_count",
      "sum(vpl.latest_price) as market_cap",
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

function latestMigrationContaining(fragment) {
  const needle = fragment.toLowerCase();
  for (const filename of listMigrationFiles().toReversed()) {
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    const content = fs.readFileSync(fullPath, "utf8");
    const normalized = content.toLowerCase();
    if (normalized.includes(needle)) {
      return { filename, content: normalized };
    }
  }
  return null;
}

// pg_get_viewdef-sourced bodies (DROP+CREATE migrations) drop the `public.`
// schema qualifier hand-written bodies carry; normalize both sides.
function stripSchema(text) {
  return text.replaceAll("public.", "");
}

// Recognize both CREATE OR REPLACE VIEW and DROP VIEW + plain CREATE VIEW (the
// latter is required when a migration drops a column from the view).
function latestViewDefinition(viewName) {
  for (const filename of listMigrationFiles().toReversed()) {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8").toLowerCase();
    if (
      content.includes(`create or replace view public.${viewName}`) ||
      content.includes(`create view public.${viewName}`)
    ) {
      return { filename, content };
    }
  }
  return null;
}

const violations = [];

for (const contract of PUBLIC_VIEW_CONTRACTS) {
  const viewDefinition = latestViewDefinition(contract.view);
  if (!viewDefinition) {
    violations.push(`${contract.view}: no CREATE [OR REPLACE] VIEW definition found`);
    continue;
  }

  const haystack = stripSchema(viewDefinition.content);
  const expectedSelects = [
    `create or replace view public.${contract.view} as select * from public.${contract.source};`,
    `create view public.${contract.view} as select * from public.${contract.source};`,
  ].map((expected) => stripSchema(expected));
  if (!expectedSelects.some((expected) => haystack.includes(expected))) {
    violations.push(`${contract.view}: ${viewDefinition.filename} must expose public.${contract.source} with SELECT *`);
  }

  const expectedGrant = stripSchema(`grant select on public.${contract.view} to anon, authenticated;`);
  if (!haystack.includes(expectedGrant)) {
    violations.push(`${contract.view}: ${viewDefinition.filename} is missing anon/authenticated SELECT grant`);
  }
}

for (const contract of REQUIRED_SOURCE_CONTRACTS) {
  const definition = latestMigrationContaining(contract.marker);
  if (!definition) {
    violations.push(`${contract.label}: no migration definition found for "${contract.marker}"`);
    continue;
  }
  for (const fragment of contract.fragments) {
    if (!definition.content.includes(fragment.toLowerCase())) {
      violations.push(`${contract.label}: ${definition.filename} is missing "${fragment}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("set summary view contract FAILED:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("set summary view contract passed");
