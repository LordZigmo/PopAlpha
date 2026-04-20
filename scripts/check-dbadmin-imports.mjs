// Build-time guard: dbAdmin() must stay inside explicitly approved
// server-only surfaces. User/public routes should use dbPublic()
// or createServerSupabaseUserClient() instead.

import fs from "node:fs";
import path from "node:path";
import {
  DBADMIN_ALLOWED_FILES,
  DBADMIN_ALLOWED_PREFIXES,
  DBADMIN_ALLOWED_ROUTE_KEYS,
} from "./security-guardrails.config.mjs";
import { readRouteRegistry, routeKeyFromFilePath } from "./lib/route-registry.mjs";

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set([".ts", ".tsx"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "supabase"]);
const TARGET_DIRS = ["app", "components", "lib", "scripts"];

const routeRegistry = readRouteRegistry();
const allowedFiles = new Set(DBADMIN_ALLOWED_FILES);
const allowedRouteKeys = new Set(DBADMIN_ALLOWED_ROUTE_KEYS);

const dbAdminImportPattern = /import\s*\{[^}]*\bdbAdmin\b[^}]*\}\s*from\s*["'][^"']*\/db\/admin["']/;
const dbAdminCallPattern = /\bdbAdmin\s*\(/;
const useClientPattern = /^\s*["']use client["'];/m;

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

function isAllowedPath(rel) {
  if (allowedFiles.has(rel)) return true;
  return DBADMIN_ALLOWED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

function routeKindForKey(routeKey) {
  if (routeRegistry.publicRoutes.has(routeKey)) return "public";
  if (routeRegistry.userRoutes.has(routeKey)) return "user";
  if (routeRegistry.adminRoutes.has(routeKey)) return "admin";
  if (routeRegistry.cronRoutes.has(routeKey)) return "cron";
  if (routeRegistry.debugRoutes.has(routeKey)) return "debug";
  if (routeRegistry.ingestRoutes.has(routeKey)) return "ingest";
  return null;
}

function findDbAdminSignals(source) {
  const hasImport = dbAdminImportPattern.test(source);
  const hasCall = dbAdminCallPattern.test(source);
  return {
    hasImport,
    hasCall,
    hasUsage: hasImport || hasCall,
  };
}

const violations = [];

for (const target of TARGET_DIRS) {
  const dir = path.join(ROOT, target);
  for (const filePath of walk(dir)) {
    const rel = relative(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    const signal = findDbAdminSignals(source);

    if (!signal.hasUsage) continue;

    const clientModule = useClientPattern.test(source);
    if (clientModule) {
      violations.push({
        rel,
        reason: "client-module",
        detail: "Client modules must never import or call dbAdmin().",
      });
      continue;
    }

    if (isAllowedPath(rel)) continue;

    if (rel.startsWith("app/api/") && rel.endsWith("/route.ts")) {
      const routeKey = routeKeyFromFilePath(filePath);
      const routeKind = routeKindForKey(routeKey);

      if ((routeKind === "public" || routeKind === "user") && !allowedRouteKeys.has(routeKey)) {
        violations.push({
          rel,
          reason: `${routeKind}-route`,
          detail: `${routeKind.toUpperCase()} route "${routeKey}" must not use dbAdmin().`,
        });
        continue;
      }
    }

    violations.push({
      rel,
      reason: "unapproved-server-surface",
      detail: "dbAdmin() is only allowed in explicitly approved admin, cron, ingest, debug, backfill, or allowlisted server files.",
    });
  }
}

if (violations.length > 0) {
  console.error("dbAdmin import guard FAILED:");
  for (const violation of violations.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.error(`  - ${violation.rel} [${violation.reason}] ${violation.detail}`);
  }
  console.error(
    "\nUse dbPublic() for public contracts, createServerSupabaseUserClient() for authenticated user flows, and keep dbAdmin() on server-only internal surfaces.",
  );
  process.exit(1);
}

console.log("dbAdmin import guard passed");
