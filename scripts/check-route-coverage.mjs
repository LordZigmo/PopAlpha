import fs from "node:fs";
import path from "node:path";
import { FIXED_ROUTE_CLASSIFICATIONS } from "./security-guardrails.config.mjs";
import { readRouteRegistry, routeKeyFromFilePath } from "./lib/route-registry.mjs";

const ROOT = process.cwd();
const registry = readRouteRegistry();

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

const registryEntries = [
  ["public", registry.publicRoutes],
  ["cron", registry.cronRoutes],
  ["admin", registry.adminRoutes],
  ["debug", registry.debugRoutes],
  ["ingest", registry.ingestRoutes],
  ["user", registry.userRoutes],
];

const classifiedKeys = new Set();
const duplicates = [];

for (const [kind, routes] of registryEntries) {
  for (const routeKey of routes) {
    if (classifiedKeys.has(routeKey)) {
      duplicates.push({ kind, routeKey });
      continue;
    }
    classifiedKeys.add(routeKey);
  }
}

if (duplicates.length > 0) {
  console.error("route-coverage check FAILED — duplicate API route classifications:");
  for (const { kind, routeKey } of duplicates) {
    console.error(`  - ${routeKey} appears more than once (latest duplicate in ${kind.toUpperCase()}_ROUTES)`);
  }
  process.exit(1);
}

const unclassified = [];

for (const file of routeFiles) {
  const key = routeKeyFromFilePath(file);

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

function routeKindForKey(routeKey) {
  for (const [kind, routes] of registryEntries) {
    if (routes.has(routeKey)) return kind;
  }
  return null;
}

const lockedClassificationFailures = [];
for (const [routeKey, expectedKind] of Object.entries(FIXED_ROUTE_CLASSIFICATIONS)) {
  const actualKind = routeKindForKey(routeKey);
  if (actualKind !== expectedKind) {
    lockedClassificationFailures.push({ routeKey, expectedKind, actualKind });
  }
}

if (lockedClassificationFailures.length > 0) {
  console.error("route-coverage check FAILED — locked route classifications drifted:");
  for (const failure of lockedClassificationFailures) {
    console.error(
      `  - ${failure.routeKey} must stay classified as ${failure.expectedKind}, but is currently ${failure.actualKind ?? "unclassified"}`,
    );
  }
  process.exit(1);
}

console.log(
  `route-coverage check passed (${routeFiles.length} routes, ${classifiedKeys.size} classified keys)`,
);
