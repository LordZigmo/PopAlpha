import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const LINKED_PROJECT_REF_PATH = path.join(ROOT, "supabase", ".temp", "project-ref");
const LINKED_POOLER_URL_PATH = path.join(ROOT, "supabase", ".temp", "pooler-url");
const COMMON_CLI_PATHS = ["supabase", "/opt/homebrew/bin/supabase", "/usr/local/bin/supabase"];

function runCommand(command, args) {
  const env = buildChildEnv();
  return spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
}

function buildChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_")) {
      delete env[key];
    }
  }
  return env;
}

function normalizeVersion(stdout) {
  return (stdout ?? "").trim().replace(/^supabase\s+/i, "");
}

function resolveSupabaseCli() {
  const seen = new Set();
  const cachedCliPath = findCachedSupabaseCliPath();
  const candidates = [
    process.env.SUPABASE_CLI_PATH?.trim() ?? "",
    ...COMMON_CLI_PATHS,
    cachedCliPath ?? "",
  ].filter(Boolean);

  for (const command of candidates) {
    if (seen.has(command)) continue;
    seen.add(command);

    if (command.includes(path.sep) && !fs.existsSync(command)) {
      continue;
    }

    const versionResult = runCommand(command, ["--version"]);
    if (versionResult.status === 0) {
      return {
        command,
        prefixArgs: [],
        source:
          command === (process.env.SUPABASE_CLI_PATH?.trim() ?? "")
            ? "env"
            : command === "supabase"
              ? "path"
              : command === cachedCliPath
                ? "npm-cache"
                : "common-path",
        version: normalizeVersion(versionResult.stdout),
      };
    }
  }

  return null;
}

function findCachedSupabaseCliPath() {
  const home = process.env.HOME?.trim();
  if (!home) return null;

  const npxRoot = path.join(home, ".npm", "_npx");
  if (!fs.existsSync(npxRoot)) {
    return null;
  }

  const candidates = [];
  for (const entry of fs.readdirSync(npxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(
      npxRoot,
      entry.name,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "supabase.exe" : "supabase",
    );
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    candidates.push({ candidate, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.candidate ?? null;
}

function readLinkedProjectRef() {
  if (!fs.existsSync(LINKED_PROJECT_REF_PATH)) {
    return null;
  }

  const value = fs.readFileSync(LINKED_PROJECT_REF_PATH, "utf8").trim();
  return value.length > 0 ? value : null;
}

function readLinkedPoolerUrl() {
  if (!fs.existsSync(LINKED_POOLER_URL_PATH)) {
    return null;
  }

  const value = fs.readFileSync(LINKED_POOLER_URL_PATH, "utf8").trim();
  return value.length > 0 ? value : null;
}

function resolveDbPasswordEnvName() {
  const candidates = ["SUPABASE_DB_PASSWORD", "POSTGRES_PASSWORD", "PopAlpha_POSTGRES_PASSWORD"];
  return candidates.find((name) => process.env[name]?.trim()) ?? null;
}

function resolveDbPasswordValue(envName) {
  if (!envName) return null;
  return process.env[envName]?.trim() ?? null;
}

function buildDbUrl(poolerUrl, dbPassword) {
  if (!poolerUrl || !dbPassword) {
    return null;
  }

  const url = new URL(poolerUrl);
  url.password = dbPassword;
  return url.toString();
}

function linkCommandHint(projectRef) {
  const ref = projectRef ?? process.env.SUPABASE_PROJECT_REF?.trim() ?? "<project-ref>";
  return `supabase link --project-ref ${ref}`;
}

export function getLinkedDbStatus({ access = "db-url" } = {}) {
  const cli = resolveSupabaseCli();
  const linkedProjectRef = readLinkedProjectRef();
  const linkedPoolerUrl = readLinkedPoolerUrl();
  const dbPasswordEnvName = resolveDbPasswordEnvName();
  const dbPassword = resolveDbPasswordValue(dbPasswordEnvName);
  const dbUrl = buildDbUrl(linkedPoolerUrl, dbPassword);
  const issues = [];

  if (!cli) {
    issues.push({
      code: "missing-cli",
      message:
        "Supabase CLI is not available. Install it so `supabase --version` works, set `SUPABASE_CLI_PATH=/absolute/path/to/supabase`, or prime a cached CLI binary under `~/.npm/_npx/*/node_modules/.bin/supabase`.",
    });
  }

  if (!linkedProjectRef) {
    issues.push({
      code: "missing-link",
      message:
        `The workspace is not linked to a Supabase project. Run \`${linkCommandHint(linkedProjectRef)}\` so \`supabase/.temp/project-ref\` exists.`,
    });
  }

  if (access === "db-url" && !linkedPoolerUrl) {
    issues.push({
      code: "missing-pooler-url",
      message:
        `The linked database pooler URL is missing. Run \`${linkCommandHint(linkedProjectRef)}\` so \`supabase/.temp/pooler-url\` exists.`,
    });
  }

  if (access === "db-url" && !dbPasswordEnvName) {
    issues.push({
      code: "missing-db-password",
      message:
        "Linked schema checks need a database password in the environment. Set `SUPABASE_DB_PASSWORD` (preferred) in `.env.local` before running the linked schema checks.",
    });
  }

  return {
    ready: issues.length === 0,
    cli,
    linkedProjectRef,
    linkedPoolerUrl,
    dbPasswordEnvName,
    dbUrl,
    access,
    issues,
  };
}

export function formatLinkedDbBootstrap(status, { includeSummary = true } = {}) {
  const lines = [];

  if (includeSummary) {
    lines.push(status.ready ? "Linked DB prerequisites are ready." : "Linked DB prerequisites are missing.");
  }

  if (status.cli) {
    const prefix = [status.cli.command, ...status.cli.prefixArgs].join(" ");
    lines.push(`- Supabase CLI: ${prefix} (${status.cli.source}, version ${status.cli.version || "unknown"})`);
  } else {
    lines.push("- Supabase CLI: missing");
  }

  lines.push(
    status.linkedProjectRef
      ? `- Linked project ref: ${status.linkedProjectRef} (from supabase/.temp/project-ref)`
      : "- Linked project ref: missing",
  );
  lines.push(
    status.linkedPoolerUrl
      ? "- Linked pooler URL: present (from supabase/.temp/pooler-url)"
      : "- Linked pooler URL: missing",
  );
  lines.push(
    status.dbPasswordEnvName
      ? `- DB password env: ${status.dbPasswordEnvName}`
      : "- DB password env: missing",
  );

  if (status.issues.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const issue of status.issues) {
      lines.push(`- ${issue.message}`);
    }
    lines.push(
      "- After the prerequisites are in place, run `npm run check:security` for the full invariants path or `npm run check:security:schema:local` for the linked schema contract only.",
    );
  }

  return lines.join("\n");
}

export function assertLinkedDbReady(label = "linked db command", { access = "db-url" } = {}) {
  const status = getLinkedDbStatus({ access });
  if (!status.ready) {
    throw new Error(`${label} prerequisites are not satisfied.\n${formatLinkedDbBootstrap(status, { includeSummary: false })}`);
  }
  return status;
}

export function runLinkedDbCommand(
  sql,
  { expectFailure = false, label = "query", executionMode = "db-url" } = {},
) {
  const access = executionMode === "linked" ? "linked" : "db-url";
  const status = assertLinkedDbReady(label, { access });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "popalpha-linked-db-"));
  const sqlFilePath = path.join(tempDir, "query.sql");
  fs.writeFileSync(sqlFilePath, sql, "utf8");

  const queryArgs =
    executionMode === "linked"
      ? [...status.cli.prefixArgs, "db", "query", "--linked", "-o", "json", "--file", sqlFilePath]
      : [...status.cli.prefixArgs, "db", "query", "--db-url", status.dbUrl, "-o", "json", "--file", sqlFilePath];

  const result = spawnSync(status.cli.command, queryArgs, {
    cwd: ROOT,
    env: buildChildEnv(),
    encoding: "utf8",
  });

  fs.rmSync(tempDir, { recursive: true, force: true });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`.trim();

  if (expectFailure) {
    if (result.status === 0) {
      throw new Error(`${label} unexpectedly succeeded.\n${output}`);
    }
    return output;
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed.\n${output}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON.\n${output}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parsed.rows ?? [];
}

export function runLinkedDbQuery(sql, options = {}) {
  return runLinkedDbCommand(sql, { executionMode: "db-url", ...options });
}
