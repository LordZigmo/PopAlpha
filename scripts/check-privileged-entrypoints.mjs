import fs from "node:fs";
import path from "node:path";
import {
  AUTH_GLUE_ENTRYPOINT_CONTRACTS,
  INTERNAL_ADMIN_UI_ENTRYPOINT_CONTRACTS,
  OPERATIONAL_SCRIPT_TRUST_CONTRACTS,
  PRIVILEGED_PACKAGE_SCRIPT_CONTRACTS,
  PRIVILEGED_WORKFLOW_CONTRACTS,
} from "./security-guardrails.config.mjs";

const ROOT = process.cwd();
const INTERNAL_ADMIN_ROOT = path.join(ROOT, "app", "internal", "admin");
const LIB_AUTH_ROOT = path.join(ROOT, "lib", "auth");
const WORKFLOWS_ROOT = path.join(ROOT, ".github", "workflows");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");

const INTERNAL_ADMIN_CONTRACTS = INTERNAL_ADMIN_UI_ENTRYPOINT_CONTRACTS;
const AUTH_GLUE_CONTRACTS = AUTH_GLUE_ENTRYPOINT_CONTRACTS;
const WORKFLOW_CONTRACTS = PRIVILEGED_WORKFLOW_CONTRACTS;
const PACKAGE_SCRIPT_CONTRACTS = PRIVILEGED_PACKAGE_SCRIPT_CONTRACTS;
const SENSITIVE_SCRIPT_TARGETS = new Set([
  "scripts/check-security-invariants.mjs",
  ...Object.keys(OPERATIONAL_SCRIPT_TRUST_CONTRACTS),
]);

const INTERNAL_ADMIN_SIGNAL_DETECTORS = {
  internal_admin_redirect(source) {
    return /redirect\(\s*["']\/internal\/admin/.test(source);
  },
  internal_admin_signin_ui(source) {
    return /from\s+["']@clerk\/nextjs["']/.test(source) || /\<SignIn\b/.test(source);
  },
  internal_admin_session_reader(source) {
    return /getInternalAdminSession|resolveCurrentInternalAdminAccess/.test(source);
  },
  internal_admin_session_issue_clear(source) {
    return /issueInternalAdminSession|clearInternalAdminSession/.test(source);
  },
  require_internal_admin_session(source) {
    return /requireInternalAdminSession/.test(source);
  },
  internal_admin_signout_action(source) {
    return /signOutInternalAdminAction/.test(source);
  },
  internal_admin_review_api(source) {
    return /listInternalAdminEbayDeletionTasks|getInternalAdminEbayDeletionTaskDetail/.test(source);
  },
  internal_admin_review_patch(source) {
    return /patchInternalAdminEbayDeletionTask/.test(source);
  },
  clerk_user_resolution(source) {
    return /resolveCurrentInternalAdminAccess|getInternalAdminSession/.test(source);
  },
};

const AUTH_GLUE_SIGNAL_DETECTORS = {
  clerk_middleware(source) {
    return /clerkMiddleware/.test(source);
  },
  debug_prod_gate(source) {
    return /ALLOW_DEBUG_IN_PROD/.test(source);
  },
  route_registry_import(source) {
    return /route-registry/.test(source);
  },
  route_registry(source) {
    return /export const PUBLIC_ROUTES|export const CRON_ROUTES|export const ADMIN_ROUTES|export const DEBUG_ROUTES|export const INGEST_ROUTES|export const USER_ROUTES/.test(source);
  },
  clerk_runtime_flag(source) {
    return /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|CLERK_RUNTIME_REQUIRED/.test(source);
  },
  auth_secret_resolution(source) {
    return /CRON_SECRET|ADMIN_SECRET|ADMIN_IMPORT_TOKEN|x-admin-secret/.test(source);
  },
  safe_equal(source) {
    return /safeEqual/.test(source);
  },
  clerk_user_resolution(source) {
    return /auth\(\)|currentUser\(|@clerk\/nextjs\/server/.test(source);
  },
  auth_guards(source) {
    return /requireCron|requireAdmin|requireUser|resolveAuthContext/.test(source);
  },
  internal_admin_session_signing(source) {
    return /INTERNAL_ADMIN_SESSION_SECRET|verifyInternalAdminSessionToken|createInternalAdminSessionToken|INTERNAL_ADMIN_COOKIE_NAME/.test(source);
  },
  internal_admin_allowlist(source) {
    return /INTERNAL_ADMIN_CLERK_USER_IDS|INTERNAL_ADMIN_EMAILS|resolveInternalAdminAllowlist/.test(source);
  },
};

const WORKFLOW_SIGNAL_DETECTORS = {
  github_actions_secrets(source) {
    return /secrets\./.test(source);
  },
  security_invariants_ci(source) {
    return /npm run check:security:invariants/.test(source);
  },
  linked_rls_ci(source) {
    return /npm run verify:rls:linked/.test(source);
  },
  cron_secret_call(source) {
    return /CRON_SECRET|VERCEL_AUTOMATION_BYPASS_SECRET|curl -sS -X POST/.test(source);
  },
  supabase_migration_apply(source) {
    return /supabase db push|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD/.test(source);
  },
};

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
      continue;
    }
    results.push(full);
  }
  return results;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

function sortValues(values) {
  return [...new Set(values)].sort();
}

function detectSignals(source, detectors) {
  return sortValues(
    Object.entries(detectors)
      .filter(([, detector]) => detector(source))
      .map(([signal]) => signal),
  );
}

function addFailure(failures, section, subject, message) {
  failures.push({ section, subject, message });
}

function ensureRequiredSignals(actualSignals, expectedSignals) {
  return expectedSignals.filter((signal) => !actualSignals.includes(signal));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function extractScriptPaths(command) {
  return sortValues(
    [...command.matchAll(/scripts\/[A-Za-z0-9._/-]+\.(?:mjs|ps1)/g)].map((match) => match[0]),
  );
}

function collectInternalAdminFiles() {
  return walk(INTERNAL_ADMIN_ROOT)
    .map(relative)
    .filter((file) => /(?:^|\/)(?:page|layout)\.(?:t|j)sx$/.test(file) || /(?:^|\/)actions\.(?:t|j)sx?$/.test(file))
    .sort();
}

function collectSensitiveAuthGlueFiles() {
  const authFiles = walk(LIB_AUTH_ROOT)
    .map(relative)
    .filter((file) => /\.(?:t|j)sx?$/.test(file));
  const candidates = ["proxy.ts", ...authFiles];
  const discovered = [];

  for (const relPath of candidates) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const source = fs.readFileSync(fullPath, "utf8");
    const signals = detectSignals(source, AUTH_GLUE_SIGNAL_DETECTORS);
    if (signals.length > 0) {
      discovered.push({ relPath, signals });
    }
  }

  return discovered.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function collectSensitiveWorkflowFiles() {
  return walk(WORKFLOWS_ROOT)
    .map(relative)
    .filter((file) => /\.(?:ya?ml)$/.test(file))
    .map((relPath) => {
      const source = fs.readFileSync(path.join(ROOT, relPath), "utf8");
      return { relPath, signals: detectSignals(source, WORKFLOW_SIGNAL_DETECTORS) };
    })
    .filter((entry) => entry.signals.length > 0)
    .sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function collectSensitivePackageScripts() {
  const pkg = readJson(PACKAGE_JSON_PATH);
  const scripts = pkg.scripts ?? {};
  const entries = [];

  for (const [name, command] of Object.entries(scripts)) {
    const scriptPaths = extractScriptPaths(String(command));
    const touchesSensitiveTarget = scriptPaths.some((target) => SENSITIVE_SCRIPT_TARGETS.has(target));
    const isSecurityAlias = name === "check:security" && String(command).includes("check:security:invariants");
    if (!touchesSensitiveTarget && !isSecurityAlias) {
      continue;
    }

    entries.push({
      name,
      command: String(command),
      scriptPaths,
    });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

const failures = [];

const internalAdminFiles = collectInternalAdminFiles();
const internalAdminContractPaths = new Set(Object.keys(INTERNAL_ADMIN_CONTRACTS));
for (const relPath of internalAdminFiles) {
  const contract = INTERNAL_ADMIN_CONTRACTS[relPath];
  if (!contract) {
    addFailure(
      failures,
      "internal-admin-ui",
      relPath,
      "Internal admin page/action entrypoint is not classified in INTERNAL_ADMIN_UI_ENTRYPOINT_CONTRACTS.",
    );
    continue;
  }

  const source = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const signals = detectSignals(source, INTERNAL_ADMIN_SIGNAL_DETECTORS);
  const missingSignals = ensureRequiredSignals(signals, contract.expectedSignals ?? []);
  if (missingSignals.length > 0) {
    addFailure(
      failures,
      "internal-admin-ui",
      relPath,
      `Missing expected trust signals [${missingSignals.join(", ")}]. Detected [${signals.join(", ") || "(none)"}].`,
    );
  }
}
for (const relPath of internalAdminContractPaths) {
  if (!internalAdminFiles.includes(relPath)) {
    addFailure(failures, "internal-admin-ui", relPath, "Contract entry points to a file that does not exist.");
  }
}

const authGlueFiles = collectSensitiveAuthGlueFiles();
const authGlueDiscoveredPaths = new Set(authGlueFiles.map((entry) => entry.relPath));
for (const entry of authGlueFiles) {
  const contract = AUTH_GLUE_CONTRACTS[entry.relPath];
  if (!contract) {
    addFailure(
      failures,
      "auth-glue",
      entry.relPath,
      `Sensitive auth glue file detected with signals [${entry.signals.join(", ")}] but no AUTH_GLUE_ENTRYPOINT_CONTRACTS entry exists.`,
    );
    continue;
  }

  const missingSignals = ensureRequiredSignals(entry.signals, contract.expectedSignals ?? []);
  if (missingSignals.length > 0) {
    addFailure(
      failures,
      "auth-glue",
      entry.relPath,
      `Missing expected trust signals [${missingSignals.join(", ")}]. Detected [${entry.signals.join(", ")}].`,
    );
  }
}
for (const relPath of Object.keys(AUTH_GLUE_CONTRACTS)) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    addFailure(failures, "auth-glue", relPath, "Contract entry points to a file that does not exist.");
    continue;
  }
  if (!authGlueDiscoveredPaths.has(relPath)) {
    addFailure(
      failures,
      "auth-glue",
      relPath,
      "Contract entry is not matched by the current privileged auth-glue discovery rules.",
    );
  }
}

const workflowFiles = collectSensitiveWorkflowFiles();
const workflowDiscoveredPaths = new Set(workflowFiles.map((entry) => entry.relPath));
for (const entry of workflowFiles) {
  const contract = WORKFLOW_CONTRACTS[entry.relPath];
  if (!contract) {
    addFailure(
      failures,
      "workflows",
      entry.relPath,
      `Sensitive workflow detected with signals [${entry.signals.join(", ")}] but no PRIVILEGED_WORKFLOW_CONTRACTS entry exists.`,
    );
    continue;
  }

  const missingSignals = ensureRequiredSignals(entry.signals, contract.expectedSignals ?? []);
  if (missingSignals.length > 0) {
    addFailure(
      failures,
      "workflows",
      entry.relPath,
      `Missing expected trust signals [${missingSignals.join(", ")}]. Detected [${entry.signals.join(", ")}].`,
    );
  }
}
for (const relPath of Object.keys(WORKFLOW_CONTRACTS)) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    addFailure(failures, "workflows", relPath, "Contract entry points to a workflow file that does not exist.");
    continue;
  }
  if (!workflowDiscoveredPaths.has(relPath)) {
    addFailure(
      failures,
      "workflows",
      relPath,
      "Contract entry is not matched by the current sensitive workflow discovery rules.",
    );
  }
}

const sensitivePackageScripts = collectSensitivePackageScripts();
const packageScriptNames = new Set(sensitivePackageScripts.map((entry) => entry.name));
for (const entry of sensitivePackageScripts) {
  const contract = PACKAGE_SCRIPT_CONTRACTS[entry.name];
  if (!contract) {
    addFailure(
      failures,
      "package-scripts",
      entry.name,
      `Privileged package script is not classified in PRIVILEGED_PACKAGE_SCRIPT_CONTRACTS. Command: ${entry.command}`,
    );
    continue;
  }

  const missingFragments = (contract.expectedCommandFragments ?? []).filter(
    (fragment) => !entry.command.includes(fragment),
  );
  if (missingFragments.length > 0) {
    addFailure(
      failures,
      "package-scripts",
      entry.name,
      `Command drifted from its contract. Missing fragments [${missingFragments.join(", ")}] in: ${entry.command}`,
    );
  }

  if (typeof contract.target === "string" && contract.target.startsWith("scripts/")) {
    const fullPath = path.join(ROOT, contract.target);
    if (!fs.existsSync(fullPath)) {
      addFailure(
        failures,
        "package-scripts",
        entry.name,
        `Contract target ${contract.target} does not exist.`,
      );
    }
  }
}
for (const [scriptName, contract] of Object.entries(PACKAGE_SCRIPT_CONTRACTS)) {
  if (!packageScriptNames.has(scriptName)) {
    addFailure(
      failures,
      "package-scripts",
      scriptName,
      "Contract entry does not map to a currently discovered privileged package script.",
    );
  }
  if (!Array.isArray(contract.requiredTrustInputs) || contract.requiredTrustInputs.length === 0) {
    addFailure(
      failures,
      "package-scripts",
      scriptName,
      "Package script contract must declare requiredTrustInputs.",
    );
  }
}

if (failures.length > 0) {
  console.error("privileged entrypoint check FAILED:");
  for (const failure of failures.sort((a, b) => a.section.localeCompare(b.section) || a.subject.localeCompare(b.subject))) {
    console.error(`  - ${failure.subject} [${failure.section}] ${failure.message}`);
  }
  console.error(
    "\nClassify privileged non-route entrypoints in scripts/security-guardrails.config.mjs and keep package-script/workflow/auth-glue contracts aligned with the actual implementation.",
  );
  process.exit(1);
}

console.log(
  `privileged entrypoint check passed (${internalAdminFiles.length} internal-admin UI entries, ${authGlueFiles.length} auth glue files, ${workflowFiles.length} workflows, ${sensitivePackageScripts.length} package scripts classified)`,
);
