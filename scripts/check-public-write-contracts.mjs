import fs from "node:fs";
import path from "node:path";
import {
  PUBLIC_CALLABLE_FUNCTION_CONTRACTS,
  PUBLIC_FUNCTION_EXECUTE_ALLOWLIST,
  PUBLIC_WRITE_ROUTE_CONTRACTS,
} from "./security-guardrails.config.mjs";
import { readRouteRegistry, routeKeyFromFilePath } from "./lib/route-registry.mjs";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "app", "api");
const authGuardPattern = /\b(requireCron|requireAdmin|requireUser|requireOnboarded)\s*\(/;

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

function sortValues(values) {
  return [...values].sort();
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function formatList(values) {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function routeKindForKey(routeKey, registry) {
  if (registry.publicRoutes.has(routeKey)) return "public";
  if (registry.ingestRoutes.has(routeKey)) return "ingest";
  if (registry.userRoutes.has(routeKey)) return "user";
  if (registry.adminRoutes.has(routeKey)) return "admin";
  if (registry.cronRoutes.has(routeKey)) return "cron";
  if (registry.debugRoutes.has(routeKey)) return "debug";
  return "unknown";
}

function extractWriteMethods(source) {
  const methods = new Set();
  for (const match of source.matchAll(/export async function (POST|PUT|PATCH|DELETE)\b/g)) {
    methods.add(match[1]);
  }
  return sortValues(methods);
}

function hasExplicitAuthGuard(source) {
  return authGuardPattern.test(source);
}

const registry = readRouteRegistry();
const failures = [];
const writeRouteContracts = PUBLIC_WRITE_ROUTE_CONTRACTS;
const writeRouteKeys = new Set(Object.keys(writeRouteContracts));
const writeRouteFiles = new Map();

for (const filePath of walk(API_DIR)) {
  const routeKey = routeKeyFromFilePath(filePath);
  const source = fs.readFileSync(filePath, "utf8");
  const methods = extractWriteMethods(source);
  if (methods.length === 0) continue;

  const routeKind = routeKindForKey(routeKey, registry);
  writeRouteFiles.set(routeKey, { filePath, methods, routeKind });

  const contract = writeRouteContracts[routeKey];
  const requiresContract = routeKind === "public"
    || (routeKind === "ingest" && (!hasExplicitAuthGuard(source) || contract));

  if (requiresContract) {
    if (!contract) {
      failures.push({
        section: "route-contracts",
        message: `${routeKey} (${routeKind}) exports [${formatList(methods)}] but is missing PUBLIC_WRITE_ROUTE_CONTRACTS classification.`,
      });
      continue;
    }

    if (contract.routeClass !== routeKind) {
      failures.push({
        section: "route-contracts",
        message: `${routeKey} is classified as ${routeKind} in lib/auth/route-registry.ts but ${contract.routeClass} in PUBLIC_WRITE_ROUTE_CONTRACTS.`,
      });
    }

    const expectedMethods = sortValues(contract.methods);
    if (!sameValues(methods, expectedMethods)) {
      failures.push({
        section: "route-contracts",
        message: `${routeKey} exports [${formatList(methods)}] but PUBLIC_WRITE_ROUTE_CONTRACTS expects [${formatList(expectedMethods)}].`,
      });
    }
  } else if (writeRouteKeys.has(routeKey)) {
    failures.push({
      section: "route-contracts",
      message: `${routeKey} is listed in PUBLIC_WRITE_ROUTE_CONTRACTS but is currently classified as ${routeKind}.`,
    });
  }
}

for (const [routeKey, contract] of Object.entries(writeRouteContracts)) {
  const route = writeRouteFiles.get(routeKey);
  if (!route) {
    failures.push({
      section: "route-contracts",
      message: `${routeKey} is listed in PUBLIC_WRITE_ROUTE_CONTRACTS but no write route file was found for it.`,
    });
    continue;
  }

  if (route.routeKind !== contract.routeClass) {
    failures.push({
      section: "route-contracts",
      message: `${routeKey} is listed for ${contract.routeClass} writes but the route registry currently classifies it as ${route.routeKind}.`,
    });
  }
}

const callableContractKeys = sortValues(Object.keys(PUBLIC_CALLABLE_FUNCTION_CONTRACTS));
const allowlistKeys = sortValues(Object.keys(PUBLIC_FUNCTION_EXECUTE_ALLOWLIST));

for (const signature of callableContractKeys) {
  const contractRoles = sortValues(PUBLIC_CALLABLE_FUNCTION_CONTRACTS[signature].roles);
  const allowlistRoles = sortValues(PUBLIC_FUNCTION_EXECUTE_ALLOWLIST[signature] ?? []);
  if (!sameValues(contractRoles, allowlistRoles)) {
    failures.push({
      section: "function-contracts",
      message: `${signature} has callable roles [${formatList(contractRoles)}] in PUBLIC_CALLABLE_FUNCTION_CONTRACTS but [${formatList(allowlistRoles)}] in PUBLIC_FUNCTION_EXECUTE_ALLOWLIST.`,
    });
  }
}

for (const signature of allowlistKeys) {
  if (!(signature in PUBLIC_CALLABLE_FUNCTION_CONTRACTS)) {
    failures.push({
      section: "function-contracts",
      message: `${signature} is allowlisted for EXECUTE but is missing PUBLIC_CALLABLE_FUNCTION_CONTRACTS classification.`,
    });
  }
}

if (failures.length > 0) {
  console.error("public write contract check FAILED:");
  for (const section of [...new Set(failures.map((failure) => failure.section))]) {
    console.error(`\n[${section}]`);
    for (const failure of failures.filter((entry) => entry.section === section)) {
      console.error(`  - ${failure.message}`);
    }
  }
  console.error(
    "\nClassify public/ingest write routes in scripts/security-guardrails.config.mjs and keep public callable function contracts aligned with the execute allowlist.",
  );
  process.exit(1);
}

console.log(
  `public write contract check passed (${writeRouteKeys.size} classified public/ingest write routes, ${allowlistKeys.length} callable functions)`,
);
