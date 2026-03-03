// Build-time guard: dbAdmin() must only appear in approved locations.
// Prevents accidental service-role usage in public routes, user routes,
// pages, and components.
//
// Usage:  node scripts/check-dbadmin-imports.mjs
// Exit 1 on failure so it can gate `npm run build`.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set([".ts", ".tsx"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "pokemon-tcg-data", "supabase"]);

// Paths (relative to ROOT, forward slashes) where dbAdmin is allowed.
const ALLOWED_PREFIXES = [
  "app/api/cron/",
  "app/api/admin/",
  "app/api/debug/",
  "app/api/ingest/",
  "app/api/market/observe/",
  "app/api/psa/cert/route.ts",
  "lib/db/admin.ts",
  "lib/backfill/",
  "scripts/",
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

const violations = [];
const TARGET_DIRS = ["app", "lib", "components"];

for (const target of TARGET_DIRS) {
  const dir = path.join(ROOT, target);
  for (const filePath of walk(dir)) {
    const rel = relative(filePath);
    const source = fs.readFileSync(filePath, "utf8");

    if (!source.includes("dbAdmin")) continue;

    const allowed = ALLOWED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix));
    if (!allowed) {
      violations.push(rel);
    }
  }
}

if (violations.length > 0) {
  console.error("dbAdmin import guard FAILED — forbidden usage in:");
  for (const v of violations.sort()) {
    console.error(`  - ${v}`);
  }
  console.error(
    "\ndbAdmin() is restricted to cron, admin, debug, ingest routes, and lib/backfill.",
  );
  console.error("Use dbPublic() from \"@/lib/db\" for reads and user-scoped queries.");
  process.exit(1);
}

console.log("dbAdmin import guard passed");
