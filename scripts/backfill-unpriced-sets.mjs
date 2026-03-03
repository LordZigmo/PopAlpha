/**
 * backfill-unpriced-sets.mjs
 *
 * For each set that has a provider_set_map entry but 0 price_snapshots,
 * call the existing backfill endpoint to sync prices from JustTCG.
 *
 * Prerequisites:
 * - Run backfill-all-sets.mjs first to ensure all sets are mapped
 * - Local dev server must be running (`npm run dev`)
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-unpriced-sets.mjs
 *   node --env-file=.env.local scripts/backfill-unpriced-sets.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-unpriced-sets.mjs --max-sets=10
 *   node --env-file=.env.local scripts/backfill-unpriced-sets.mjs --resume
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const STATE_PATH = path.join(process.cwd(), "scripts", "backfill-state.json");
const PROVIDER = "JUSTTCG";

function resolveBaseUrl() {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return "http://localhost:3000";
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { processedSets: [], lastRun: null };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
  if (!cronSecret) throw new Error("CRON_SECRET is required.");

  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const resume = args.has("--resume");
  const maxSetsArg = [...args].find((a) => a.startsWith("--max-sets="));
  const maxSets = maxSetsArg ? Number(maxSetsArg.split("=", 2)[1]) : Infinity;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const baseUrl = resolveBaseUrl();
  const state = resume ? loadState() : { processedSets: [], lastRun: null };
  const processedSetCodes = new Set(state.processedSets);

  // 1. Load all provider_set_map entries with confidence > 0
  console.log("Loading provider_set_map...");
  const { data: mapRows, error: mapError } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, canonical_set_name, provider_set_id, confidence")
    .eq("provider", PROVIDER)
    .gt("confidence", 0);
  if (mapError) throw new Error(`provider_set_map: ${mapError.message}`);
  console.log(`  ${mapRows.length} mapped sets with confidence > 0`);

  // 2. Find sets with 0 price_snapshots
  console.log("Checking price_snapshots coverage...");
  const unpricedSets = [];

  for (const row of mapRows) {
    if (processedSetCodes.has(row.canonical_set_code)) continue;

    // Check if this set has any price_snapshots by looking at card_printings
    // that belong to this set and joining to price_snapshots
    const { count, error } = await supabase
      .from("price_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("provider", PROVIDER)
      .like("provider_ref", `%${row.provider_set_id.replace(/-pokemon$/, "")}%`)
      .limit(1);

    // Fallback: check by canonical_slug matching set pattern
    if (error || count === null) {
      // Alternative: check card_printings for this set_code → canonical_slugs → price_snapshots
      const { data: printings } = await supabase
        .from("card_printings")
        .select("canonical_slug")
        .eq("set_code", row.canonical_set_code)
        .limit(5);

      if (printings && printings.length > 0) {
        const slugs = printings.map((p) => p.canonical_slug).filter(Boolean);
        if (slugs.length > 0) {
          const { count: snapCount } = await supabase
            .from("price_snapshots")
            .select("id", { count: "exact", head: true })
            .in("canonical_slug", slugs)
            .limit(1);

          if (!snapCount || snapCount === 0) {
            unpricedSets.push(row);
          }
          continue;
        }
      }
      unpricedSets.push(row);
      continue;
    }

    if (count === 0) {
      unpricedSets.push(row);
    }
  }

  console.log(`\nFound ${unpricedSets.length} sets with 0 price data.`);
  if (dryRun) {
    console.log("\nSets to backfill (dry run):");
    for (const row of unpricedSets) {
      console.log(`  ${row.canonical_set_code.padEnd(15)} ${(row.canonical_set_name ?? "").padEnd(35)} ${row.provider_set_id}`);
    }
    console.log("\n(DRY RUN -- no changes)");
    return;
  }

  // 3. Process each unpriced set via backfill endpoint
  let processed = 0;
  let totalMatched = 0;
  let totalHistory = 0;
  let failed = 0;

  for (const row of unpricedSets) {
    if (processed >= maxSets) {
      console.log(`\nReached --max-sets=${maxSets}, stopping.`);
      break;
    }

    const t0 = Date.now();
    const params = new URLSearchParams({
      set: row.provider_set_id,
      canonicalSetName: row.canonical_set_name ?? "",
      providerSetId: row.provider_set_id,
      aggressive: "1",
    });
    const url = `${baseUrl}/api/debug/justtcg/backfill-set?${params.toString()}`;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      });
      const result = await resp.json().catch(() => null);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (result?.ok || (result?.matchedCount ?? 0) > 0) {
        const matched = result.matchedCount ?? 0;
        const total = result.printingsSelected ?? 0;
        const history = result.historyPointsWritten ?? 0;
        totalMatched += matched;
        totalHistory += history;
        console.log(
          `OK  ${row.canonical_set_code.padEnd(15)} ${(row.canonical_set_name ?? "").padEnd(35)} ` +
          `${matched}/${total} matched  ${String(history).padStart(7)} pts  ${elapsed}s`,
        );
      } else {
        const err = (result?.firstError ?? result?.error ?? "unknown").slice(0, 80);
        console.log(
          `ERR ${row.canonical_set_code.padEnd(15)} ${(row.canonical_set_name ?? "").padEnd(35)} ` +
          `${elapsed}s -- ${err}`,
        );
        failed++;
        processed++;
        continue; // don't mark failed sets as processed — allows retry
      }
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `ERR ${row.canonical_set_code.padEnd(15)} ${(row.canonical_set_name ?? "").padEnd(35)} ` +
        `${elapsed}s -- ${e.message?.slice(0, 80)}`,
      );
      failed++;
      processed++;
      continue; // don't mark failed sets as processed — allows retry
    }

    // Only mark successful sets as processed
    processedSetCodes.add(row.canonical_set_code);
    state.processedSets = [...processedSetCodes];
    state.lastRun = { at: new Date().toISOString(), setCode: row.canonical_set_code };
    saveState(state);
    processed++;

    // Rate limit: 1s between sets
    await sleep(1000);
  }

  // 4. Summary
  console.log("\n=== SUMMARY ===");
  console.log(`Sets processed:    ${processed}`);
  console.log(`Sets failed:       ${failed}`);
  console.log(`Total matched:     ${totalMatched}`);
  console.log(`History points:    ${totalHistory.toLocaleString()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
