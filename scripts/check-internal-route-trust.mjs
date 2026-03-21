import fs from "node:fs";
import path from "node:path";
import { INTERNAL_ROUTE_TRUST_CONTRACTS } from "./security-guardrails.config.mjs";
import { readRouteRegistry } from "./lib/route-registry.mjs";

const ROOT = process.cwd();
const registry = readRouteRegistry();
const failures = [];

const TRUST_MODEL_RULES = {
  internal_admin_session: {
    required: [/\brequireInternalAdminApiAccess\s*\(/, /\bcookie\b/],
    forbidden: [/\brequireAdmin\s*\(/, /x-admin-secret/, /ADMIN_SECRET/],
  },
  admin_secret: {
    required: [/\brequireAdmin\s*\(/],
    forbidden: [/\brequireInternalAdminApiAccess\s*\(/],
  },
  admin_import_token: {
    required: [/ADMIN_IMPORT_TOKEN/],
    forbidden: [/\brequireInternalAdminApiAccess\s*\(/],
  },
  cron_secret: {
    required: [/\brequireCron\s*\(/],
    forbidden: [/\brequireInternalAdminApiAccess\s*\(/],
  },
};

function addFailure(kind, routeKey, message) {
  failures.push({ kind, routeKey, message });
}

const internalRouteEntries = [
  ...[...registry.adminRoutes].map((routeKey) => ({ routeKey, registryKind: "admin" })),
  ...[...registry.cronRoutes].map((routeKey) => ({ routeKey, registryKind: "cron" })),
];

const internalRouteKeys = new Set(internalRouteEntries.map((entry) => entry.routeKey));
const contractKeys = Object.keys(INTERNAL_ROUTE_TRUST_CONTRACTS);

for (const { routeKey, registryKind } of internalRouteEntries) {
  const contract = INTERNAL_ROUTE_TRUST_CONTRACTS[routeKey];
  if (!contract) {
    addFailure("missing-contract", routeKey, `Missing INTERNAL_ROUTE_TRUST_CONTRACTS entry for ${registryKind} route.`);
    continue;
  }

  if (contract.registryKind !== registryKind) {
    addFailure(
      "registry-kind",
      routeKey,
      `Expected registryKind ${registryKind} but contract declares ${contract.registryKind}.`,
    );
  }

  if (contract.uiBacked && contract.trustModel !== "internal_admin_session") {
    addFailure(
      "ui-backed-auth",
      routeKey,
      `UI-backed internal routes must use trustModel "internal_admin_session", not "${contract.trustModel}".`,
    );
  }

  if (registryKind === "cron" && contract.uiBacked) {
    addFailure("ui-backed-cron", routeKey, "Cron routes must never be classified as UI-backed.");
  }

  const rules = TRUST_MODEL_RULES[contract.trustModel];
  if (!rules) {
    addFailure("unknown-trust-model", routeKey, `Unknown trustModel "${contract.trustModel}".`);
    continue;
  }

  const relFiles = (contract.authSourceFiles?.length ? contract.authSourceFiles : [`app/api/${routeKey}/route.ts`]);
  const sourceChunks = [];
  for (const relFile of relFiles) {
    const filePath = path.join(ROOT, relFile);
    if (!fs.existsSync(filePath)) {
      addFailure("missing-auth-source", routeKey, `Configured auth source file ${relFile} does not exist.`);
      continue;
    }
    sourceChunks.push({ relFile, source: fs.readFileSync(filePath, "utf8") });
  }

  if (sourceChunks.length === 0) {
    continue;
  }

  const combinedSource = sourceChunks.map((entry) => `// ${entry.relFile}\n${entry.source}`).join("\n\n");

  for (const pattern of rules.required) {
    if (!pattern.test(combinedSource)) {
      addFailure(
        "missing-auth-signal",
        routeKey,
        `Expected auth sources [${relFiles.join(", ")}] to include ${pattern}, but it was not found.`,
      );
    }
  }

  for (const pattern of rules.forbidden) {
    if (pattern.test(combinedSource)) {
      addFailure(
        "forbidden-auth-signal",
        routeKey,
        `Auth sources [${relFiles.join(", ")}] unexpectedly include ${pattern}.`,
      );
    }
  }
}

for (const routeKey of contractKeys) {
  if (!internalRouteKeys.has(routeKey)) {
    addFailure("extra-contract", routeKey, "Contract entry does not map to a current admin or cron route.");
  }
}

if (failures.length > 0) {
  console.error("internal route trust check FAILED:");
  for (const failure of failures.sort((a, b) => a.routeKey.localeCompare(b.routeKey) || a.kind.localeCompare(b.kind))) {
    console.error(`  - ${failure.routeKey} [${failure.kind}] ${failure.message}`);
  }
  console.error(
    "\nClassify every admin/cron route in scripts/security-guardrails.config.mjs and keep UI-backed admin routes on internal-admin session auth only.",
  );
  process.exit(1);
}

console.log(`internal route trust check passed (${internalRouteKeys.size} internal routes classified)`);
