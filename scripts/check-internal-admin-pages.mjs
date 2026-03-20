import fs from "node:fs";
import path from "node:path";
import { INTERNAL_ADMIN_ALLOWED_PAGE_FETCH_PREFIXES, INTERNAL_ADMIN_PAGE_ROOTS } from "./security-guardrails.config.mjs";

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set([".ts", ".tsx"]);
const violations = [];

const useClientPattern = /^\s*["']use client["'];/m;
const dbAdminImportPattern = /import\s*\{[^}]*\bdbAdmin\b[^}]*\}\s*from\s*["'][^"']*\/db\/admin["']/;
const dbAdminCallPattern = /\bdbAdmin\s*\(/;
const fetchPattern = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

for (const root of INTERNAL_ADMIN_PAGE_ROOTS) {
  for (const filePath of walk(path.join(ROOT, root))) {
    const rel = relative(filePath);
    const source = fs.readFileSync(filePath, "utf8");

    if (useClientPattern.test(source)) {
      violations.push({
        rel,
        reason: "client-module",
        detail: "Internal admin pages must stay server-rendered; do not add `use client` here.",
      });
    }

    if (dbAdminImportPattern.test(source) || dbAdminCallPattern.test(source)) {
      violations.push({
        rel,
        reason: "dbadmin",
        detail: "Internal admin pages must go through the audited admin JSON routes, not dbAdmin().",
      });
    }

    const matches = [...source.matchAll(fetchPattern)];
    for (const match of matches) {
      const target = match[1];
      if (!target.startsWith("/api/")) continue;
      if (!INTERNAL_ADMIN_ALLOWED_PAGE_FETCH_PREFIXES.some((prefix) => target.startsWith(prefix))) {
        violations.push({
          rel,
          reason: "unexpected-fetch-target",
          detail: `Internal admin pages may only call ${INTERNAL_ADMIN_ALLOWED_PAGE_FETCH_PREFIXES.join(", ")}, but found ${target}.`,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("internal-admin page guard FAILED:");
  for (const violation of violations.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.error(`  - ${violation.rel} [${violation.reason}] ${violation.detail}`);
  }
  process.exit(1);
}

console.log("internal-admin page guard passed");
