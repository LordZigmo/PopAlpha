import fs from "node:fs";
import path from "node:path";
import { DEBUG_ROUTE_TRUST_CONTRACTS } from "./security-guardrails.config.mjs";
import { readRouteRegistry } from "./lib/route-registry.mjs";

const ROOT = process.cwd();
const registry = readRouteRegistry();
const failures = [];

const TRUST_MODEL_RULES = {
  debug_cron_guard: {
    required: [/\brequireCron\s*\(/],
    forbidden: [/\brequireInternalAdminApiAccess\s*\(/],
  },
  debug_internal_admin_session: {
    required: [/\brequireInternalAdminApiAccess\s*\(/, /\bcookie\b/],
    forbidden: [/\brequireCron\s*\(/, /\brequireAdmin\s*\(/, /x-admin-secret/, /ADMIN_SECRET/],
  },
  debug_deprecated: {
    required: [/NextResponse\.json/, /retired|deprecated|disabled/i],
    forbidden: [/\brequireInternalAdminApiAccess\s*\(/],
  },
};

function addFailure(kind, routeKey, message) {
  failures.push({ kind, routeKey, message });
}

const debugRouteEntries = [...registry.debugRoutes].map((routeKey) => ({ routeKey, registryKind: "debug" }));
const debugRouteKeys = new Set(debugRouteEntries.map((entry) => entry.routeKey));
const contractKeys = Object.keys(DEBUG_ROUTE_TRUST_CONTRACTS);

for (const { routeKey, registryKind } of debugRouteEntries) {
  const contract = DEBUG_ROUTE_TRUST_CONTRACTS[routeKey];
  if (!contract) {
    addFailure("missing-contract", routeKey, `Missing DEBUG_ROUTE_TRUST_CONTRACTS entry for ${registryKind} route.`);
    continue;
  }

  if (contract.registryKind !== registryKind) {
    addFailure(
      "registry-kind",
      routeKey,
      `Expected registryKind ${registryKind} but contract declares ${contract.registryKind}.`,
    );
  }

  if (contract.uiBacked && contract.trustModel !== "debug_internal_admin_session") {
    addFailure(
      "ui-backed-auth",
      routeKey,
      `UI-backed debug routes must use trustModel "debug_internal_admin_session", not "${contract.trustModel}".`,
    );
  }

  const rules = TRUST_MODEL_RULES[contract.trustModel];
  if (!rules) {
    addFailure("unknown-trust-model", routeKey, `Unknown trustModel "${contract.trustModel}".`);
    continue;
  }

  const relFile = `app/api/${routeKey}/route.ts`;
  const filePath = path.join(ROOT, relFile);
  if (!fs.existsSync(filePath)) {
    addFailure("missing-route-file", routeKey, `Expected route file ${relFile} does not exist.`);
    continue;
  }

  const source = fs.readFileSync(filePath, "utf8");
  for (const pattern of rules.required) {
    if (!pattern.test(source)) {
      addFailure(
        "missing-auth-signal",
        routeKey,
        `Expected ${relFile} to include ${pattern}, but it was not found.`,
      );
    }
  }

  for (const pattern of rules.forbidden) {
    if (pattern.test(source)) {
      addFailure(
        "forbidden-auth-signal",
        routeKey,
        `Expected ${relFile} to avoid ${pattern}, but it was found.`,
      );
    }
  }
}

for (const routeKey of contractKeys) {
  if (!debugRouteKeys.has(routeKey)) {
    addFailure("extra-contract", routeKey, "Contract entry does not map to a current debug route.");
  }
}

if (failures.length > 0) {
  console.error("debug route trust check FAILED:");
  for (const failure of failures.sort((a, b) => a.routeKey.localeCompare(b.routeKey) || a.kind.localeCompare(b.kind))) {
    console.error(`  - ${failure.routeKey} [${failure.kind}] ${failure.message}`);
  }
  console.error(
    "\nClassify every debug route in scripts/security-guardrails.config.mjs and keep UI-backed debug routes on internal-admin session auth only.",
  );
  process.exit(1);
}

console.log(`debug route trust check passed (${debugRouteKeys.size} debug routes classified)`);
