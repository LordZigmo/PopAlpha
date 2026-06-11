#!/usr/bin/env node

/**
 * Owner-run PSA SpecID discovery driver (Population Tables Phase 2b).
 *
 * Same engine as /api/cron/discover-psa-specs, run locally so the
 * GetSetItems mechanics can be validated from a residential connection
 * before any production schedule exists (PSA fronts www.psacard.com
 * with Cloudflare; datacenter egress may be challenged), and so big
 * one-time backfills don't ride a 300s serverless window.
 *
 * Usage (requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * in .env.local):
 *
 *   # 1. Register a page (SQL, one row per PSA pop set page):
 *   #    insert into psa_pop_set_pages (heading_id, category_id, title, year, language, canonical_set_code, set_confidence, notes)
 *   #    values (<id from the pop URL>, <TCG categoryID>, '<page title>', '2023', 'JP', 'sv4a_ja', 1.0, 'seeded by hand');
 *
 *   # 2. Probe it without writing:
 *   node --experimental-strip-types --loader ./scripts/ts-root-loader.mjs \
 *     scripts/discover-psa-specs.mjs --headingId=189863 --dry-run
 *
 *   # 3. Ingest for real (targets + pop snapshots + match):
 *   node --experimental-strip-types --loader ./scripts/ts-root-loader.mjs \
 *     scripts/discover-psa-specs.mjs --headingId=189863
 *
 *   # 4. Walk the registry rotation (oldest-scraped first):
 *   node --experimental-strip-types --loader ./scripts/ts-root-loader.mjs \
 *     scripts/discover-psa-specs.mjs --pages=5
 */

import dotenv from "dotenv";

import { runPsaSpecDiscovery } from "@/lib/backfill/psa-spec-discovery";

dotenv.config({ path: ".env.local", quiet: true });

function parseIntArg(argv, name) {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) return null;
  const value = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const argv = process.argv.slice(2);
const headingId = parseIntArg(argv, "headingId");
const pages = parseIntArg(argv, "pages");
const dryRun = argv.includes("--dry-run");
const noSnapshot = argv.includes("--no-snapshot");
const noMatch = argv.includes("--no-match");

const result = await runPsaSpecDiscovery({
  headingId,
  pageLimit: pages ?? undefined,
  dryRun,
  snapshot: !noSnapshot,
  match: !noMatch,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
