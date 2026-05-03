import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, ".env.local");

function buildNodeCommand(scriptPath, { useEnvFile = false } = {}) {
  const args = [];
  if (useEnvFile && fs.existsSync(ENV_FILE)) {
    args.push(`--env-file=${ENV_FILE}`);
  }
  args.push(scriptPath);
  return { command: process.execPath, args };
}

const CHECKS = [
  {
    id: "route-coverage",
    invariant: "Every API route surface is explicitly classified.",
    ...buildNodeCommand("scripts/check-route-coverage.mjs"),
  },
  {
    id: "internal-admin-pages",
    invariant: "Internal admin pages stay server-rendered and avoid direct privileged fetch patterns.",
    ...buildNodeCommand("scripts/check-internal-admin-pages.mjs"),
  },
  {
    id: "internal-route-trust",
    invariant: "No UI-backed internal/admin route relies on secret auth as its normal path.",
    ...buildNodeCommand("scripts/check-internal-route-trust.mjs"),
  },
  {
    id: "debug-route-trust",
    invariant: "Every debug route is explicitly classified and kept on the intended trust model.",
    ...buildNodeCommand("scripts/check-debug-route-trust.mjs"),
  },
  {
    id: "public-write-contracts",
    invariant: "Every public write route is explicitly classified.",
    ...buildNodeCommand("scripts/check-public-write-contracts.mjs"),
  },
  {
    id: "privileged-entrypoints",
    invariant: "Non-route privileged entrypoints remain explicitly classified and aligned with their trust model.",
    ...buildNodeCommand("scripts/check-privileged-entrypoints.mjs"),
  },
  {
    id: "script-trust",
    invariant: "Every security-sensitive operational script is explicitly classified.",
    ...buildNodeCommand("scripts/check-operational-script-trust.mjs"),
  },
  {
    id: "dbadmin-guard",
    invariant: "No user-facing route imports or uses dbAdmin().",
    ...buildNodeCommand("scripts/check-dbadmin-imports.mjs"),
  },
  {
    id: "migration-function-body",
    invariant:
      "Migrations redefining a public function reference the latest prior definer in their header (forces author to diff the body before lifting).",
    ...buildNodeCommand("scripts/check-migration-function-body.mjs"),
  },
  {
    id: "schema-contract",
    invariant: "Public table/view/function/sequence contracts do not drift from config.",
    ...buildNodeCommand("scripts/check-supabase-security.mjs", { useEnvFile: true }),
  },
];

const warnings = [];
if (!process.env.INTERNAL_ADMIN_SESSION_SECRET?.trim() && process.env.ADMIN_SECRET?.trim()) {
  warnings.push(
    "INTERNAL_ADMIN_SESSION_SECRET is unset, so internal-admin cookies fall back to ADMIN_SECRET. Set a dedicated session secret to keep those controls distinct.",
  );
}

const results = CHECKS.map((check) => {
  const result = spawnSync(check.command, check.args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });

  const output = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();

  return {
    ...check,
    ok: result.status === 0,
    output,
    status: result.status ?? 1,
    error: result.error?.message ?? null,
  };
});

const failed = results.filter((result) => !result.ok);

function formatCommand(result) {
  return [result.command, ...result.args].join(" ");
}

if (failed.length > 0) {
  console.error("Security invariants check FAILED:");
  for (const result of results) {
    const marker = result.ok ? "PASS" : "FAIL";
    console.error(`- [${marker}] ${result.id}: ${result.invariant}`);
    if (!result.ok) {
      console.error(`  Command: ${formatCommand(result)}`);
      if (result.error) {
        console.error(`  Error: ${result.error}`);
      }
      if (result.output) {
        for (const line of result.output.split("\n")) {
          console.error(`  ${line}`);
        }
      }
    }
  }
  if (warnings.length > 0) {
    console.error("\nWarnings:");
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }
  console.error(
    "\nRun the failing command directly for deeper output. Use `npm run check:security:doctor` to verify local linked-schema prerequisites, or `npm run check:security:static` if you only need repo-local checks.",
  );
  process.exit(1);
}

const passedCount = results.filter((result) => result.ok).length;
console.log(`Security invariants check passed (${passedCount} passed).`);
for (const result of results) {
  console.log(`- [PASS] ${result.id}: ${result.invariant}`);
}
if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}
