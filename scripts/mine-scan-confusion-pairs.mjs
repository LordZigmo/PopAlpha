#!/usr/bin/env node
// Mine scanner CONFUSION PAIRS from PostHog into a training-usable dataset.
//
// The no-build bridge for scanner training data (Phase 0). User corrections
// in the multi-scan tray already emit a `scanner_multi_mode_row_corrected`
// event to PostHog carrying `from_slug` (the model's wrong top-1) and
// `to_slug` (the user-confirmed truth). That signal is durable in PostHog
// TODAY -- no app build required. This script materializes it into a clean,
// catalog-validated confusion-pair dataset that the SigLIP-2 fine-tune
// (Phase 1) can consume as hard negatives.
//
// Why this matters: `from_slug -> to_slug` IS a measured embedding-space
// false-attractor. For an image whose truth is `to_slug`, the embedder
// ranked `from_slug` higher -- the exact contrastive pair we want to push
// apart. We don't need the user's photo: the catalog reference art for both
// slugs supplies the pixels (same approach as export-finetune-dataset.mjs's
// hard-negative mining).
//
// SCOPE / HONESTY: this captures multi-scan-tray corrections only, and they
// are LABEL-ONLY (no user image). The single-scan picker emits no correction
// event, and online single scans don't submit at all. Full image-bearing
// pairs from every correction path require the iOS fix (Phase 0.1) and a new
// build. This is a bridge, not the fix.
//
// Usage:
//   POSTHOG_PERSONAL_API_KEY=phx_... \
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run scanner:confusion-pairs
//
//   npm run scanner:confusion-pairs -- --since 90 --out data/confusion.json
//
// Flags:
//   --since <days>   Lookback window in days. Default 365.
//   --event <name>   Source event. Default scanner_multi_mode_row_corrected.
//   --out <path>     Output JSON path. Default data/scanner-confusion-pairs-<YYYY-MM-DD>.json
//   --dry-run        Print the summary, write nothing.
//
// Requires: POSTHOG_PERSONAL_API_KEY (PostHog -> Settings -> Personal API keys),
//           SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: POSTHOG_HOST (default https://us.posthog.com), POSTHOG_PROJECT_ID.

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const POSTHOG_HOST = (process.env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/$/, "");
const POSTHOG_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
// Same capture token hardcoded in ios/AnalyticsService.swift -- used only to
// FIND the project; it cannot authenticate this script.
const PROJECT_CAPTURE_TOKEN = "phc_sCBhLBr4jbxrgXkWXSdUCEz2J9SVva9u7kqa96LU4DBu";
const DEFAULT_EVENT = "scanner_multi_mode_row_corrected";
const DATASET_VERSION = "scanner-confusion-pairs-v1";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return v;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function phApi(method, apiPath, body) {
  const res = await fetch(`${POSTHOG_HOST}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${POSTHOG_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text for the error path */
  }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json) : text.slice(0, 300);
    throw new Error(`${method} ${apiPath} -> ${res.status}: ${detail}`);
  }
  return json;
}

async function resolveProjectId() {
  if (process.env.POSTHOG_PROJECT_ID) return process.env.POSTHOG_PROJECT_ID;
  const projects = await phApi("GET", "/api/projects/");
  const match = (projects.results ?? []).find((p) => p.api_token === PROJECT_CAPTURE_TOKEN);
  if (!match) {
    throw new Error(
      "Could not find a project whose capture token matches the app's. " +
        "Set POSTHOG_PROJECT_ID explicitly (PostHog -> Settings -> Project -> Project ID).",
    );
  }
  return match.id;
}

// HogQL is parameterized only by trusted constants here (event name is
// validated to a safe identifier, since is an integer) so string-building is
// acceptable; never interpolate untrusted input into a HogQL string.
async function fetchCorrectionEvents({ projectId, event, since }) {
  if (!/^[a-z0-9_]+$/i.test(event)) throw new Error(`unsafe event name: ${event}`);
  const days = Number.parseInt(String(since), 10);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`invalid --since: ${since}`);
  const query = `
    SELECT
      toString(properties.from_slug) AS from_slug,
      toString(properties.to_slug) AS to_slug,
      toString(properties.confidence) AS confidence,
      toString(toDate(timestamp)) AS d,
      distinct_id
    FROM events
    WHERE event = '${event}'
      AND timestamp > now() - INTERVAL ${days} DAY
      AND notEmpty(toString(properties.to_slug))
    ORDER BY timestamp DESC
    LIMIT 10000`;
  const resp = await phApi("POST", `/api/projects/${projectId}/query`, {
    query: { kind: "HogQLQuery", query },
  });
  const cols = resp.columns ?? ["from_slug", "to_slug", "confidence", "d", "distinct_id"];
  return (resp.results ?? []).map((row) => {
    const rec = {};
    cols.forEach((c, i) => { rec[c] = row[i]; });
    return rec;
  });
}

// Validate slugs against the live catalog in batches; returns a Set of slugs
// that exist in canonical_cards. A to_slug that doesn't resolve can't be a
// training target (and would fail the scan_correction_pairs FK if ever
// promoted), so we drop those pairs and report the count.
async function loadValidSlugs(supabase, slugs) {
  const valid = new Set();
  const unique = [...new Set(slugs)].filter(Boolean);
  const BATCH = 200;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug")
      .in("slug", batch);
    if (error) throw new Error(`canonical_cards lookup failed: ${error.message}`);
    for (const r of data ?? []) valid.add(r.slug);
  }
  return valid;
}

function aggregate(rows, validSlugs) {
  const byPair = new Map();
  let droppedInvalidTo = 0;
  let droppedNoOp = 0;
  let droppedInvalidFrom = 0;
  for (const r of rows) {
    const from = r.from_slug || null;
    const to = r.to_slug || null;
    if (!to || !validSlugs.has(to)) { droppedInvalidTo += 1; continue; }
    // No-op "correction": the tray Edit picker still offers the current top
    // match, so a user can re-pick the slug the model already had. That's not
    // a confusion pair -- training the same catalog card as both anchor
    // positive and its own hard negative would be harmful. Drop it.
    if (from && from === to) { droppedNoOp += 1; continue; }
    // Hard negatives need catalog art for from_slug. A stale/renamed/missing
    // from_slug can't supply pixels for Phase 1, so drop it rather than poison
    // the dataset or inflate pair_count. Counted separately as diagnostics.
    if (!from || !validSlugs.has(from)) { droppedInvalidFrom += 1; continue; }
    const key = `${from}|${to}`;
    if (!byPair.has(key)) {
      byPair.set(key, {
        from_slug: from,
        to_slug: to,
        from_in_catalog: true,
        occurrences: 0,
        confidences: {},
        first_seen: r.d,
        last_seen: r.d,
        distinct_users: new Set(),
      });
    }
    const p = byPair.get(key);
    p.occurrences += 1;
    if (r.confidence) p.confidences[r.confidence] = (p.confidences[r.confidence] ?? 0) + 1;
    if (r.d && r.d < p.first_seen) p.first_seen = r.d;
    if (r.d && r.d > p.last_seen) p.last_seen = r.d;
    if (r.distinct_id) p.distinct_users.add(r.distinct_id);
  }
  const pairs = [...byPair.values()]
    .map((p) => ({ ...p, distinct_users: p.distinct_users.size }))
    .sort((a, b) => b.occurrences - a.occurrences);
  return { pairs, droppedInvalidTo, droppedNoOp, droppedInvalidFrom };
}

async function main() {
  const args = parseArgs(process.argv);
  const event = typeof args.event === "string" ? args.event : DEFAULT_EVENT;
  const since = typeof args.since === "string" ? args.since : "365";
  requireEnv("POSTHOG_PERSONAL_API_KEY");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  const projectId = await resolveProjectId();
  console.log(`PostHog project ${projectId} @ ${POSTHOG_HOST} -- event=${event} since=${since}d`);

  const rows = await fetchCorrectionEvents({ projectId, event, since });
  console.log(`Fetched ${rows.length} correction event(s).`);

  const allSlugs = rows.flatMap((r) => [r.from_slug, r.to_slug]);
  const validSlugs = await loadValidSlugs(supabase, allSlugs);
  const { pairs, droppedInvalidTo, droppedNoOp, droppedInvalidFrom } = aggregate(rows, validSlugs);

  const highWrong = pairs.filter((p) => (p.confidences.high ?? 0) > 0);
  console.log(
    `Confusion pairs: ${pairs.length} (events=${rows.length}, dropped-invalid-to=${droppedInvalidTo}, dropped-no-op=${droppedNoOp}, dropped-invalid-from=${droppedInvalidFrom}, high-confidence-wrong=${highWrong.length})`,
  );
  for (const p of pairs.slice(0, 15)) {
    console.log(`  ${p.from_slug} -> ${p.to_slug}  x${p.occurrences}`);
  }

  const payload = {
    dataset: "scanner-confusion-pairs",
    version: DATASET_VERSION,
    generated_at: new Date().toISOString(),
    source: `posthog:${event}`,
    host: POSTHOG_HOST,
    project_id: String(projectId),
    since_days: Number.parseInt(String(since), 10),
    semantics: "from_slug = model's wrong top-1; to_slug = user-confirmed truth. For an anchor image of to_slug, from_slug is a hard negative.",
    scope: "multi-scan tray corrections only; LABEL-ONLY (no user image). Bridge while Phase 0.1 ships image-bearing pairs from all correction paths.",
    event_count: rows.length,
    pair_count: pairs.length,
    dropped_invalid_to: droppedInvalidTo,
    dropped_no_op: droppedNoOp,
    dropped_invalid_from: droppedInvalidFrom,
    high_confidence_wrong_count: highWrong.length,
    pairs,
  };

  if (args["dry-run"]) {
    console.log("--dry-run: nothing written.");
    return;
  }
  const outPath =
    typeof args.out === "string"
      ? args.out
      : path.join("data", `scanner-confusion-pairs-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${pairs.length} pairs -> ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
