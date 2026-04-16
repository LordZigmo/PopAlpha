#!/usr/bin/env node
/**
 * bulk-downsample-price-history.mjs
 *
 * One-shot bulk downsample of price_history_points to shrink the table from
 * ~13M rows toward ~3M rows. Calls the public.downsample_price_history_points_batch
 * RPC day-by-day in a tight loop, bypassing the 300s cron maxDuration.
 *
 * Per the 2026-04-16 incident recovery plan (Phase 3). Runs safely on the
 * post-fix pipeline — the RPC has a 120s statement_timeout built in and only
 * DELETEs, never blocking new writes.
 *
 * Usage:
 *   node scripts/bulk-downsample-price-history.mjs [options]
 *
 * Options:
 *   --batch=N           Rows deleted per RPC call. Default 10000. Max 50000.
 *   --sleep-ms=N        Pause between batches in ms. Default 1500. Higher =
 *                       more breathing room for the pipeline.
 *   --max-days=N        Stop after processing N days. Default: run until
 *                       nothing older than 30 days needs downsampling.
 *   --start-date=YYYY-MM-DD  Skip forward to this date. Useful if you
 *                       interrupted a prior run. Default: oldest needing work.
 *   --max-total-deleted=N  Hard stop after N total deletions (safety rail).
 *                       Default: no limit.
 *   --dry-run           Find the oldest candidate day, report what would run,
 *                       don't delete anything.
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (from .env.local)
 *
 * Interruption: Ctrl-C at any time is safe. Pick up where you left off
 * with --start-date equal to the last printed "day: YYYY-MM-DD" line.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_BATCH = 10_000;
const MAX_BATCH = 50_000;
const DEFAULT_SLEEP_MS = 1500;
const RETENTION_CUTOFF_DAYS = 30;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[bulk-downsample] missing env: ${name}`);
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

function parseStringArg(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseBoolFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

async function findOldestCandidateDay(supabase) {
  const cutoff = new Date(Date.now() - RETENTION_CUTOFF_DAYS * 86_400_000);
  const { data, error } = await supabase
    .from("price_history_points")
    .select("ts")
    .lt("ts", cutoff.toISOString())
    .order("ts", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`find oldest candidate: ${error.message}`);
  if (!data) return null;
  const day = new Date(data.ts);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

async function downsampleDay(supabase, dayStart, dayEnd, batchSize) {
  let dayDeleted = 0;
  // Inner loop: keep calling until this day returns fewer than batchSize
  // rows (meaning we've cleaned all intra-day duplicates for that day).
  // Cap at 50 inner iterations per day as a safety rail.
  for (let batch = 0; batch < 50; batch += 1) {
    const { data, error } = await supabase.rpc(
      "downsample_price_history_points_batch",
      {
        p_batch_size: batchSize,
        p_older_than: dayEnd.toISOString(),
        p_newer_than: dayStart.toISOString(),
      },
    );
    if (error) {
      throw new Error(`downsample ${isoDay(dayStart)} batch ${batch}: ${error.message}`);
    }
    const deleted = Number((data && data.deleted) || 0);
    dayDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return dayDeleted;
}

async function main() {
  const argv = process.argv.slice(2);
  const batchSize = Math.min(MAX_BATCH, parseIntArg(argv, "batch", DEFAULT_BATCH));
  const sleepMs = parseIntArg(argv, "sleep-ms", DEFAULT_SLEEP_MS);
  const maxDays = parseIntArg(argv, "max-days", Infinity);
  const maxTotalDeleted = parseIntArg(argv, "max-total-deleted", Infinity);
  const startDateArg = parseStringArg(argv, "start-date");
  const dryRun = parseBoolFlag(argv, "dry-run");

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let currentDay;
  if (startDateArg) {
    currentDay = new Date(`${startDateArg}T00:00:00Z`);
    if (Number.isNaN(currentDay.getTime())) {
      console.error(`[bulk-downsample] invalid --start-date: ${startDateArg}`);
      process.exit(1);
    }
  } else {
    currentDay = await findOldestCandidateDay(supabase);
    if (!currentDay) {
      console.log("[bulk-downsample] no data older than 30 days needs downsampling — done.");
      return;
    }
  }

  const cutoff = new Date(Date.now() - RETENTION_CUTOFF_DAYS * 86_400_000);
  cutoff.setUTCHours(0, 0, 0, 0);

  console.log("[bulk-downsample] starting", {
    from: isoDay(currentDay),
    toCutoff: isoDay(cutoff),
    batchSize,
    sleepMs,
    maxDays: Number.isFinite(maxDays) ? maxDays : "∞",
    maxTotalDeleted: Number.isFinite(maxTotalDeleted) ? maxTotalDeleted : "∞",
    dryRun,
  });

  if (dryRun) {
    console.log("[bulk-downsample] dry run: would start processing. exiting.");
    return;
  }

  const startedAt = Date.now();
  let totalDeleted = 0;
  let daysProcessed = 0;

  // Graceful shutdown on SIGINT — finish the in-flight day, then exit.
  let shouldStop = false;
  process.on("SIGINT", () => {
    if (shouldStop) process.exit(130);
    shouldStop = true;
    console.log("[bulk-downsample] SIGINT received — finishing current day, then exiting. Ctrl-C again to force.");
  });

  while (daysProcessed < maxDays && totalDeleted < maxTotalDeleted) {
    if (currentDay >= cutoff) {
      console.log("[bulk-downsample] reached 30-day retention boundary — done.");
      break;
    }

    const dayStart = new Date(currentDay);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const dayLabel = isoDay(dayStart);

    const dayStartedAt = Date.now();
    let dayDeleted = 0;
    try {
      dayDeleted = await downsampleDay(supabase, dayStart, dayEnd, batchSize);
    } catch (err) {
      console.error(`[bulk-downsample] error on ${dayLabel}: ${err.message}`);
      console.error("[bulk-downsample] retry this run with --start-date=" + dayLabel);
      process.exit(1);
    }

    const dayDurationSec = ((Date.now() - dayStartedAt) / 1000).toFixed(1);
    totalDeleted += dayDeleted;
    daysProcessed += 1;

    console.log(
      `[bulk-downsample] day ${dayLabel} deleted=${dayDeleted} durationSec=${dayDurationSec} totalDeleted=${totalDeleted}`,
    );

    if (shouldStop) {
      console.log(`[bulk-downsample] stopping after ${dayLabel}. resume with --start-date=${isoDay(new Date(currentDay.getTime() + 86_400_000))}`);
      break;
    }

    currentDay = new Date(currentDay.getTime() + 86_400_000);

    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("[bulk-downsample] finished", {
    daysProcessed,
    totalDeleted,
    totalSec,
  });
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[bulk-downsample] fatal:", err);
    process.exit(1);
  });
}
