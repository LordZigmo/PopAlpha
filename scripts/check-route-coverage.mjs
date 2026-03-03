// Build-time check: every app/api/ route.ts file must be classified
// in lib/auth/route-registry.ts (or live under the debug/ subtree).
//
// Usage:  node scripts/check-route-coverage.mjs
// Exit 1 on failure so it can gate `npm run build`.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// ── 1. Parse route-registry.ts to extract all classified route keys ─────────
const registryPath = path.join(ROOT, "lib", "auth", "route-registry.ts");
const registrySource = fs.readFileSync(registryPath, "utf8");

// Every route key in the file is a double-quoted string inside an array.
const classifiedKeys = new Set(
  [...registrySource.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
);

// ── 2. Glob app/api/**/route.ts to find all actual API routes ───────────────
function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

const apiDir = path.join(ROOT, "app", "api");
const routeFiles = walk(apiDir);

// ── 3. Convert each file path to a route key ────────────────────────────────
// app/api/cron/sync-canonical/route.ts  →  "cron/sync-canonical"
// app/api/cards/[slug]/detail/route.ts  →  "cards/[slug]/detail"
function toRouteKey(filePath) {
  const rel = path.relative(apiDir, filePath).replace(/\\/g, "/");
  // Strip trailing /route.ts
  return rel.replace(/\/route\.ts$/, "");
}

// ── 4. Check each route is classified ───────────────────────────────────────
const unclassified = [];

for (const file of routeFiles) {
  const key = toRouteKey(file);

  // Debug subtree is handled by prefix — individual routes don't need listing
  if (key.startsWith("debug/") || key === "debug") continue;

  if (!classifiedKeys.has(key)) {
    unclassified.push(key);
  }
}

if (unclassified.length > 0) {
  console.error("route-coverage check FAILED — unclassified API routes:");
  for (const key of unclassified.sort()) {
    console.error(`  - ${key}`);
  }
  console.error(
    "\nAdd each route to the appropriate array in lib/auth/route-registry.ts",
  );
  process.exit(1);
}

console.log(
  `route-coverage check passed (${routeFiles.length} routes, ${classifiedKeys.size} classified keys)`,
);
