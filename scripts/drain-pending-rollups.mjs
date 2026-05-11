#!/usr/bin/env node
/**
 * Hammer the batch-refresh-pipeline-rollups cron until pending_rollups is
 * drained. Used after queue-jp-pending-rollups.mjs seeds the queue.
 *
 * The cron processes up to 4500 keys per call; for ~50k JP rollups we
 * expect ~12 iterations. Bails after MAX_RUNS or when count reaches 0.
 *
 * Required env: CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET ?? process.env.CRON_AUTH_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET) {
  console.error("[drain-pending-rollups] missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const CRON_URL =
  process.env.DRAIN_CRON_URL ?? "https://popalpha.ai/api/cron/batch-refresh-pipeline-rollups";
const MAX_RUNS = Number.parseInt(process.env.DRAIN_MAX_RUNS ?? "20", 10);
const SLEEP_MS = Number.parseInt(process.env.DRAIN_SLEEP_MS ?? "1000", 10);

async function getCount() {
  const { count, error } = await supabase
    .from("pending_rollups")
    .select("canonical_slug", { count: "exact", head: true });
  if (error) throw new Error(`pending_rollups(count): ${error.message}`);
  return count ?? 0;
}

async function triggerCron() {
  const startedAt = Date.now();
  const res = await fetch(CRON_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const elapsed = Date.now() - startedAt;
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, elapsed_ms: elapsed, body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`[drain-pending-rollups] target: ${CRON_URL}`);
  const initialCount = await getCount();
  console.log(`[drain-pending-rollups] initial pending_rollups count: ${initialCount}`);
  if (initialCount === 0) {
    console.log("[drain-pending-rollups] nothing to drain — exiting");
    return;
  }

  let prevCount = initialCount;
  for (let run = 1; run <= MAX_RUNS; run += 1) {
    const result = await triggerCron();
    const afterCount = await getCount();
    const delta = prevCount - afterCount;
    console.log(
      `[drain-pending-rollups] run ${run}: status=${result.status} elapsed=${result.elapsed_ms}ms processed≈${delta} remaining=${afterCount}`,
    );
    if (afterCount === 0) {
      console.log("[drain-pending-rollups] queue drained ✓");
      return;
    }
    if (delta <= 0 && run > 2) {
      console.warn("[drain-pending-rollups] no progress on run", run, "— likely stuck; bailing");
      break;
    }
    prevCount = afterCount;
    await sleep(SLEEP_MS);
  }

  const finalCount = await getCount();
  console.log(`[drain-pending-rollups] final remaining: ${finalCount} after ${MAX_RUNS} runs`);
}

main().catch((error) => {
  console.error("[drain-pending-rollups] FAILED:", error);
  process.exit(1);
});
