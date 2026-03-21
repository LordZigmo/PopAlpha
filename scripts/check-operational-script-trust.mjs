import fs from "node:fs";
import path from "node:path";
import { OPERATIONAL_SCRIPT_TRUST_CONTRACTS } from "./security-guardrails.config.mjs";

const ROOT = process.cwd();
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const ENTRY_EXTENSIONS = new Set([".mjs", ".ps1"]);
const CONTRACTS = OPERATIONAL_SCRIPT_TRUST_CONTRACTS;
const INCLUDED_GUARDRAIL_SCRIPTS = new Set([
  "scripts/check-linked-db-prereqs.mjs",
  "scripts/check-supabase-security.mjs",
]);
const EXCLUDED_GUARDRAIL_SCRIPTS = new Set([
  "scripts/check-dbadmin-imports.mjs",
  "scripts/check-debug-route-trust.mjs",
  "scripts/check-handle-validation.mjs",
  "scripts/check-internal-admin-pages.mjs",
  "scripts/check-internal-route-trust.mjs",
  "scripts/check-no-cards-axis.mjs",
  "scripts/check-operational-script-trust.mjs",
  "scripts/check-privileged-entrypoints.mjs",
  "scripts/check-public-write-contracts.mjs",
  "scripts/check-route-coverage.mjs",
  "scripts/check-security-invariants.mjs",
]);

const SIGNAL_DETECTORS = {
  linked_db_helper(source) {
    return /from\s+["']\.\/lib\/linked-db\.mjs["']/.test(source)
      || /\brunLinkedDb(?:Command|Query)\s*\(/.test(source)
      || /\bgetLinkedDbStatus\s*\(/.test(source);
  },
  ebay_verification_bootstrap(source) {
    return /EBAY_VERIFICATION_TOKEN/.test(source)
      && /VERIFICATION_TOKEN=/.test(source)
      && /ENDPOINT_URL=/.test(source);
  },
  service_role_client(source) {
    return /\bdbAdmin\s*\(/.test(source)
      || ((/\b(createClient|createSupabaseClient)\s*\(/.test(source)
        || /from\s+["']@supabase\/supabase-js["']/.test(source))
        && /SUPABASE_SERVICE_ROLE_KEY/.test(source));
  },
  admin_secret_route_driver(source, relPath) {
    if (relPath.endsWith(".ps1")) {
      return /\$env:ADMIN_SECRET\b/i.test(source) || /x-admin-secret/i.test(source);
    }
    return /x-admin-secret/.test(source) || (/ADMIN_SECRET/.test(source) && /\bfetch\s*\(/.test(source));
  },
  admin_import_token_route_driver(source) {
    return /ADMIN_IMPORT_TOKEN/.test(source) && /\bfetch\s*\(/.test(source);
  },
  cron_secret_route_driver(source) {
    return /CRON_SECRET/.test(source) && /\bfetch\s*\(/.test(source);
  },
  vercel_env_pull(source, relPath) {
    if (!relPath.endsWith(".ps1")) return false;
    return /\bvercel env pull\b/i.test(source)
      && /Set-Content -Path \$TargetPath/i.test(source);
  },
};

function walkScripts(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "lib") continue;
      walkScripts(full, files);
      continue;
    }

    if (ENTRY_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

function shouldInspect(relPath) {
  if (INCLUDED_GUARDRAIL_SCRIPTS.has(relPath)) return true;
  if (EXCLUDED_GUARDRAIL_SCRIPTS.has(relPath)) return false;
  if (relPath === "scripts/security-guardrails.config.mjs") return false;
  return true;
}

function sortValues(values) {
  return [...values].sort();
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function detectSignals(source, relPath) {
  const matches = [];
  for (const [signal, detector] of Object.entries(SIGNAL_DETECTORS)) {
    if (detector(source, relPath)) {
      matches.push(signal);
    }
  }
  return sortValues(matches);
}

const sensitiveScripts = [];
for (const filePath of walkScripts(SCRIPTS_DIR)) {
  const relPath = relative(filePath);
  if (!shouldInspect(relPath)) continue;
  const source = fs.readFileSync(filePath, "utf8");
  const signals = detectSignals(source, relPath);
  if (signals.length > 0) {
    sensitiveScripts.push({ relPath, signals });
  }
}

const failures = [];
const sensitivePaths = new Set(sensitiveScripts.map((entry) => entry.relPath));

function addFailure(kind, relPath, message) {
  failures.push({ kind, relPath, message });
}

for (const { relPath, signals } of sensitiveScripts) {
  const contract = CONTRACTS[relPath];
  if (!contract) {
    addFailure("missing-contract", relPath, `Detected security-sensitive signals [${signals.join(", ")}] but no OPERATIONAL_SCRIPT_TRUST_CONTRACTS entry exists.`);
    continue;
  }

  const expectedSignals = sortValues(contract.expectedSignals ?? []);
  if (!sameValues(signals, expectedSignals)) {
    addFailure(
      "signal-drift",
      relPath,
      `Detected signals [${signals.join(", ")}] do not match the contract [${expectedSignals.join(", ")}].`,
    );
  }

  const expectsServiceRole = Boolean(contract.usesServiceRole);
  const detectedServiceRole = signals.includes("service_role_client");
  if (expectsServiceRole !== detectedServiceRole) {
    addFailure(
      "service-role-drift",
      relPath,
      `Contract says usesServiceRole=${expectsServiceRole}, but detected service-role access is ${detectedServiceRole}.`,
    );
  }
}

for (const [relPath, contract] of Object.entries(CONTRACTS)) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    addFailure("missing-file", relPath, "Contract entry points to a file that does not exist.");
    continue;
  }

  if (!sensitivePaths.has(relPath)) {
    addFailure("extra-contract", relPath, "Contract entry does not map to a currently detected security-sensitive operational script.");
  }

  if (!Array.isArray(contract.requiredTrustInputs) || contract.requiredTrustInputs.length === 0) {
    addFailure("missing-trust-inputs", relPath, "Contract entry must declare requiredTrustInputs.");
  }
}

if (failures.length > 0) {
  console.error("operational script trust check FAILED:");
  for (const failure of failures.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.kind.localeCompare(b.kind))) {
    console.error(`  - ${failure.relPath} [${failure.kind}] ${failure.message}`);
  }
  console.error(
    "\nClassify every security-sensitive operational script in scripts/security-guardrails.config.mjs and keep the contract aligned with the script's actual trust inputs.",
  );
  process.exit(1);
}

console.log(`operational script trust check passed (${sensitiveScripts.length} scripts classified)`);
