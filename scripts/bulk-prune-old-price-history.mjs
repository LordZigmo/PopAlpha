#!/usr/bin/env node
/**
 * bulk-prune-old-price-history.mjs
 *
 * Hard-deletes price_history_points rows older than 90 days in large chunks.
 * Complements the daily prune_old_data() cron, which hard-deletes at 5,000
 * rows/invocation — too slow to drain a multi-million-row backlog.
 *
 * Per the 2026-04-16 incident recovery plan (Phase 3). The daily cron's
 * step 7a already does exactly this, just slowly:
 *   DELETE FROM price_history_points WHERE ts < now() - interval '90 days' LIMIT 5000
 * This script fires the same delete in larger chunks until drained.
 *
 * Usage:
 *   node scripts/bulk-prune-old-price-history.mjs [options]
 *
 * Options:
 *   --batch=N           Rows deleted per DELETE. Default 50000. Max 200000.
 *                       Larger batches are faster but hold locks longer.
 *   --sleep-ms=N        Pause between batches in ms. Default 2000. Raise if
 *                       pipeline jobs start timing out.
 *   --max-deleted=N     Hard stop after N total deletions. Default: unlimited.
 *   --retention-days=N  Rows older than this many days are deleted.
 *                       Default 90 (matches prune_old_data step 7a).
 *   --dry-run           Report how many rows WOULD be deleted, don't run.
 *
 * Safety: only touches rows where ts < now() - interval '90 days'. Never
 * affects recent data or new writes. Interrupt with Ctrl-C at any time.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_BATCH = 50_000;
const MAX_BATCH = 200_000;
const DEFAULT_SLEEP_MS = 2_000;
const DEFAULT_RETENTION_DAYS = 90;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[bulk-prune] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function parseIntArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countOldRows(supabase, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const { count, error } = await supabase
    .from("price_history_points")
    .select("id", { count: "exact", head: true })
    .lt("ts", cutoff);
  if (error) throw new Error(`count old rows: ${error.message}`);
  return count ?? 0;
}

async function deleteBatch(supabase, retentionDays, batchSize) {
  // Use an RPC to get reliable row_count return. We build the RPC as an
  // anonymous DO block via .rpc isn't possible — instead, use the same
  // pattern the cron uses: select IDs then delete by id.
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  // Step 1: claim batch of IDs
  const { data: idsData, error: idsError } = await supabase
    .from("price_history_points")
    .select("id")
    .lt("ts", cutoff)
    .limit(batchSize);
  if (idsError) throw new Error(`select old ids: ${idsError.message}`);
  const ids = (idsData ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;

  // Step 2: delete by id. PostgREST URL length limit is ~8KB by default;
  // UUIDs are ~36 chars + URL-encoded delimiters ≈ 50 bytes each, so
  // 100 UUIDs per .in() call leaves comfortable headroom. Bigger sizes
  // return 400 Bad Request. (Same failure mode we fixed for
  // price_snapshots in commit 11de000.)
  let deletedTotal = 0;
  const idChunkSize = 100;
  for (let i = 0; i < ids.length; i += idChunkSize) {
    const chunk = ids.slice(i, i + idChunkSize);
    const { error } = await supabase
      .from("price_history_points")
      .delete()
      .in("id", chunk);
    if (error) throw new Error(`delete batch: ${error.message}`);
    deletedTotal += chunk.length;
  }
  return deletedTotal;
}

async function main() {
  const argv = process.argv.slice(2);
  const batchSize = Math.min(MAX_BATCH, parseIntArg(argv, "batch", DEFAULT_BATCH));
  const sleepMs = parseIntArg(argv, "sleep-ms", DEFAULT_SLEEP_MS);
  const retentionDays = parseIntArg(argv, "retention-days", DEFAULT_RETENTION_DAYS);
  const maxDeleted = parseIntArg(argv, "max-deleted", Infinity);
  const dryRun = parseBoolFlag(argv, "dry-run");

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const initialCount = await countOldRows(supabase, retentionDays);
  console.log("[bulk-prune] starting", {
    retentionDays,
    rowsToDelete: initialCount,
    batchSize,
    sleepMs,
    maxDeleted: Number.isFinite(maxDeleted) ? maxDeleted : "∞",
    dryRun,
  });

  if (initialCount === 0) {
    console.log("[bulk-prune] no rows older than retention cutoff — done.");
    return;
  }

  if (dryRun) {
    console.log(`[bulk-prune] dry run: would delete ${initialCount} rows. exiting.`);
    return;
  }

  let shouldStop = false;
  process.on("SIGINT", () => {
    if (shouldStop) process.exit(130);
    shouldStop = true;
    console.log("[bulk-prune] SIGINT received — finishing current batch. Ctrl-C again to force.");
  });

  const startedAt = Date.now();
  let totalDeleted = 0;
  let batchNum = 0;

  while (totalDeleted < maxDeleted) {
    batchNum += 1;
    const batchStartedAt = Date.now();
    let deleted = 0;
    try {
      deleted = await deleteBatch(supabase, retentionDays, batchSize);
    } catch (err) {
      console.error(`[bulk-prune] error on batch ${batchNum}: ${err.message}`);
      process.exit(1);
    }

    const durationSec = ((Date.now() - batchStartedAt) / 1000).toFixed(1);
    totalDeleted += deleted;

    console.log(
      `[bulk-prune] batch=${batchNum} deleted=${deleted} durationSec=${durationSec} totalDeleted=${totalDeleted}`,
    );

    if (deleted === 0) {
      console.log("[bulk-prune] no more rows older than cutoff — done.");
      break;
    }

    if (shouldStop) {
      console.log("[bulk-prune] stopping by user request.");
      break;
    }

    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const finalCount = await countOldRows(supabase, retentionDays);
  console.log("[bulk-prune] finished", {
    batches: batchNum,
    totalDeleted,
    totalSec,
    remainingOldRows: finalCount,
  });
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[bulk-prune] fatal:", err);
    process.exit(1);
  });
}
