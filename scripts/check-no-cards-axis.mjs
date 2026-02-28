import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGET_DIRS = ["app", "lib", "components", "scripts"];
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "pokemon-tcg-data", "supabase"]);
const LEGACY_WRITE_TABLES = [
  "holdings",
  "market_latest",
  "market_observations",
  "market_snapshots",
  "card_external_mappings",
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

const violations = [];

for (const target of TARGET_DIRS) {
  const dir = path.join(ROOT, target);
  for (const filePath of walk(dir)) {
    const rel = relative(filePath);
    if (rel === "scripts/check-no-cards-axis.mjs") continue;
    const source = fs.readFileSync(filePath, "utf8");

    if (
      source.includes('.from("cards")') ||
      source.includes(".from('cards')")
    ) {
      violations.push(`${rel}: forbidden table read/write .from('cards')`);
    }

    if (
      source.includes('.from("card_variants")') ||
      source.includes(".from('card_variants')")
    ) {
      violations.push(`${rel}: forbidden table read/write .from('card_variants')`);
    }

    for (const table of LEGACY_WRITE_TABLES) {
      const writePattern = new RegExp(
        String.raw`\.from\((['"])${table}\1\)[\s\S]{0,1200}?\.(?:insert|upsert|update)\([\s\S]{0,1200}?card_id\s*:`,
        "m",
      );
      if (writePattern.test(source)) {
        violations.push(`${rel}: forbidden legacy card_id write on ${table}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("cards-axis guard failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("cards-axis guard passed");
