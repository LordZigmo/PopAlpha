#!/usr/bin/env node
// Backfill public.sets.era + release_date from the Scrydex /expansions API.
//
// Context: PR 1 (#34) seeded public.sets from card_printings; PR 2 + PR 3
// (#35, #36, #37) wired up the FK + sync triggers; this script populates the
// curated metadata columns (era, release_date) that those PRs intentionally
// left NULL.
//
// One-shot. Builds a map of `normalize_set_id(expansion.name)` → {era,
// release_date} from /en/expansions and /ja/expansions, then UPDATEs every
// public.sets row whose values differ from Scrydex.
//
// Idempotent: re-running only updates rows whose era or release_date has
// drifted from Scrydex, and re-runs are no-ops once values are in sync.
// Safe to run periodically (e.g., monthly) as new sets release.
//
// Usage:
//   node scripts/backfill-sets-era-release-date.mjs            # apply
//   node scripts/backfill-sets-era-release-date.mjs --dry-run  # preview only
//
// Requires:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service-role write to public.sets)
//   SCRYDEX_API_KEY, SCRYDEX_TEAM_ID         (read-only /expansions)
//
// Source preservation: writes source='scrydex_set_metadata' which the PR 2
// refresh_sets_for_set_ids trigger function (20260509150000) preserves —
// future card_printings churn won't overwrite these curated values.

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");

const SCRYDEX_BASE = "https://api.scrydex.com/pokemon/v1";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

// Mirror lib/sets/summary-core.mjs buildSetId() and the SQL
// public.normalize_set_id() — kebab-case lower with non-alnum collapsed.
function buildSetId(setName) {
  const normalized = String(setName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

// Scrydex returns release_date as "YYYY/MM/DD". Normalize to ISO so the
// Postgres `date` type accepts it without any client-side coercion games.
function normalizeReleaseDate(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // Already ISO? Pass through.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // Slash form?
  const slashMatch = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const [, y, m, d] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Anything else — let Postgres try, but log so we notice odd formats.
  console.warn(`Unrecognized release_date format, passing through: ${trimmed}`);
  return trimmed;
}

async function fetchScrydex(path, params, credentials) {
  const url = new URL(`${SCRYDEX_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": credentials.apiKey,
      "X-Team-ID": credentials.teamId,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Scrydex ${path} → ${res.status}: ${body}`);
  }
  return await res.json();
}

async function fetchAllExpansions(language, credentials) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const payload = await fetchScrydex(
      `/${language}/expansions`,
      { page, page_size: pageSize },
      credentials,
    );
    const data = payload?.data ?? [];
    all.push(...data);
    if (data.length < pageSize) break;
    page += 1;
  }
  return all;
}

async function main() {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const credentials = {
    apiKey: requireEnv("SCRYDEX_API_KEY"),
    teamId: requireEnv("SCRYDEX_TEAM_ID"),
  };

  console.log(`Fetching expansions from Scrydex (${DRY_RUN ? "DRY-RUN" : "APPLY"} mode)...`);
  const enExpansions = await fetchAllExpansions("en", credentials);
  const jaExpansions = await fetchAllExpansions("ja", credentials);
  console.log(`  EN: ${enExpansions.length}`);
  console.log(`  JA: ${jaExpansions.length}`);

  // Build set_id → metadata map. If both EN and JP map to the same slug
  // (rare; Scrydex separates JP set names) the later iteration wins.
  // EN comes first so JP wins ties — JP entries usually have richer
  // metadata for JP-language slugs and worse metadata for EN slugs that
  // collide.
  const scrydexMap = new Map();
  for (const exp of enExpansions) {
    const setId = buildSetId(exp?.name);
    if (!setId) continue;
    scrydexMap.set(setId, {
      era: exp?.series ?? null,
      release_date: normalizeReleaseDate(exp?.release_date ?? exp?.releaseDate ?? null),
      sourceName: exp?.name ?? null,
      sourceLang: "en",
    });
  }
  for (const exp of jaExpansions) {
    const setId = buildSetId(exp?.name);
    if (!setId) continue;
    if (scrydexMap.has(setId)) continue; // EN wins; JP only fills gaps
    scrydexMap.set(setId, {
      era: exp?.series ?? null,
      release_date: normalizeReleaseDate(exp?.release_date ?? exp?.releaseDate ?? null),
      sourceName: exp?.name ?? null,
      sourceLang: "ja",
    });
  }
  console.log(`Built map of ${scrydexMap.size} normalized set_ids from Scrydex.\n`);

  // Read all sets rows (paginated to be safe; 401 today is well under one page).
  const { data: setsRows, error: readErr } = await supabase
    .from("sets")
    .select("set_id, set_name, era, release_date, source")
    .order("set_id", { ascending: true });
  if (readErr) throw new Error(`sets read: ${readErr.message}`);

  let toUpdate = 0;
  let alreadyCorrect = 0;
  let missing = 0;
  const updates = [];
  const missingExamples = [];

  for (const row of setsRows ?? []) {
    const meta = scrydexMap.get(row.set_id);
    if (!meta) {
      missing += 1;
      if (missingExamples.length < 10) missingExamples.push(`${row.set_id} (${row.set_name})`);
      continue;
    }
    const eraNew = meta.era ?? null;
    const dateNew = meta.release_date ?? null;
    const eraSame = (row.era ?? null) === eraNew;
    const dateSame = (row.release_date ?? null) === dateNew;
    if (eraSame && dateSame) {
      alreadyCorrect += 1;
      continue;
    }
    toUpdate += 1;
    updates.push({
      set_id: row.set_id,
      era: eraNew,
      release_date: dateNew,
    });
  }

  console.log(`Diff:`);
  console.log(`  ${toUpdate} rows differ from Scrydex (will update)`);
  console.log(`  ${alreadyCorrect} rows already match`);
  console.log(`  ${missing} rows in public.sets not found in Scrydex map`);
  if (missingExamples.length > 0) {
    console.log(`  Examples of missing: ${missingExamples.join(", ")}`);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] First 10 updates that would happen:`);
    for (const u of updates.slice(0, 10)) {
      console.log(`  ${u.set_id} → era=${JSON.stringify(u.era)} release_date=${JSON.stringify(u.release_date)}`);
    }
    console.log(`\nNo writes. Re-run without --dry-run to apply.`);
    return;
  }

  if (updates.length === 0) {
    console.log("\nNothing to update. Done.");
    return;
  }

  console.log(`\nApplying ${updates.length} updates...`);
  let applied = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("sets")
      .update({
        era: u.era,
        release_date: u.release_date,
        source: "scrydex_set_metadata",
      })
      .eq("set_id", u.set_id);
    if (error) throw new Error(`update ${u.set_id}: ${error.message}`);
    applied += 1;
    if (applied % 25 === 0 || applied === updates.length) {
      process.stdout.write(`  ${applied} / ${updates.length}\r`);
    }
  }
  console.log(`\nDone. Updated ${applied} rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
