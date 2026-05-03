import fs from "node:fs";
import path from "node:path";

// Why this check exists
// ---------------------
// Postgres functions get redefined dozens of times across migrations,
// often inside multi-purpose files. Lifting an old body without diffing
// against the LATEST prior definer has caused production outages — most
// recently the 2026-05-01 refresh_price_changes incident, where a body
// lifted from a March-3 migration re-introduced an UPDATE that clobbered
// market_price_as_of from JustTCG (slow cadence), tripping the
// compute_daily_top_movers coverage gate and stranding the homepage
// rails for two days.
//
// This linter forces every migration that redefines an existing public
// function to reference the latest prior definer in its header comment.
// The reference is purely a forcing function: it makes the author open
// the prior file and diff bodies before lifting code.
//
// Reference patterns accepted (case-insensitive, in the first 80 lines
// of the new migration):
//   -- supersedes: <prior_filename>
//   -- supercedes: <prior_filename>          (common misspelling)
//   -- Revert of <prior_filename>
//   -- Replaces <prior_filename>
//
// Grandfathering: migrations with timestamp < EXEMPT_BEFORE are not
// checked. Bump this cutoff forward only when intentionally backfilling.
//
// User memory: feedback_sql_function_latest_body.md.

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

// Cutoff: only enforce on migrations strictly after this timestamp.
// 20260502010001 is one second after the 2026-05-02 revert migration
// (20260502010000), so the rule locks in immediately for new work while
// historical migrations and the revert itself stay clean.
const EXEMPT_BEFORE = "20260502010001";

const CREATE_FN_PATTERN =
  /create\s+or\s+replace\s+function\s+(?:(?:public|"public")\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;

const HEADER_LINE_LIMIT = 80;

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function extractTimestamp(filename) {
  const match = filename.match(/^(\d{14})_/);
  return match ? match[1] : null;
}

function extractDefinedFunctions(content) {
  const names = new Set();
  CREATE_FN_PATTERN.lastIndex = 0;
  let match;
  while ((match = CREATE_FN_PATTERN.exec(content)) !== null) {
    names.add(match[1].toLowerCase());
  }
  return names;
}

function header(content) {
  return content.split("\n").slice(0, HEADER_LINE_LIMIT).join("\n");
}

function referencesPriorDefiner(headerText, priorFilenames) {
  const haystack = headerText.toLowerCase();
  return priorFilenames.some((prior) => haystack.includes(prior.toLowerCase()));
}

const migrations = listMigrationFiles();
const fileToContent = new Map();
for (const name of migrations) {
  fileToContent.set(name, fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
}

// Build: function_name -> ordered list of migrations that (re)define it.
const definersByFn = new Map();
for (const name of migrations) {
  const fns = extractDefinedFunctions(fileToContent.get(name));
  for (const fn of fns) {
    if (!definersByFn.has(fn)) definersByFn.set(fn, []);
    definersByFn.get(fn).push(name);
  }
}

const violations = [];

for (const [fnName, definers] of definersByFn.entries()) {
  if (definers.length < 2) continue;
  // For every definer EXCEPT the first one, require a reference to a prior
  // definer in the header comment.
  for (let i = 1; i < definers.length; i++) {
    const filename = definers[i];
    const ts = extractTimestamp(filename);
    if (ts && ts < EXEMPT_BEFORE) continue;
    const priorDefiners = definers.slice(0, i);
    const latestPrior = priorDefiners[priorDefiners.length - 1];
    const headerText = header(fileToContent.get(filename));
    if (!referencesPriorDefiner(headerText, priorDefiners)) {
      violations.push({
        filename,
        fnName,
        latestPrior,
        priorCount: priorDefiners.length,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("migration-function-body guard FAILED:");
  for (const v of violations.sort((a, b) => a.filename.localeCompare(b.filename))) {
    console.error(
      `  - ${v.filename} redefines public.${v.fnName} but does not reference any prior definer in its first ${HEADER_LINE_LIMIT} lines.`,
    );
    console.error(`    Latest prior definer: ${v.latestPrior} (${v.priorCount} prior definitions total).`);
    console.error(
      `    Add a header comment such as:  -- supersedes: ${v.latestPrior}`,
    );
  }
  console.error("");
  console.error(
    "Why this matters: lifting a function body from an OLD migration without diffing against the LATEST prior body has caused production outages. See docs/ingestion-pipeline-playbook.md (Incident #15: refresh_price_changes body-lift, 2026-05-01).",
  );
  console.error(
    "Once you have diffed the new body's UPDATE/RETURN columns against the latest prior body and confirmed the changes are intentional, add the header reference and re-run.",
  );
  process.exit(1);
}

console.log("migration-function-body guard passed");
