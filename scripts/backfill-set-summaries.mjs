#!/usr/bin/env node
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildSetId } from "../lib/sets/summary-core.mjs";

dotenv.config({ path: ".env.local" });

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const days = Math.max(1, Math.min(parseInt(parseArg("days", "30"), 10) || 30, 90));
const includePipelineRefresh = parseArg("refreshPipeline", "1") !== "0";
const setBatchSize = Math.max(1, Math.min(parseInt(parseArg("setBatchSize", "8"), 10) || 8, 25));
const sleepMs = Math.max(0, Math.min(parseInt(parseArg("sleepMs", "150"), 10) || 150, 5000));
const lookbackDays = Math.min(days + 35, 365);
const today = new Date().toISOString().slice(0, 10);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, fn, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(250 * attempt);
      }
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const { data: setRows, error: setError } = await withRetry(
  "load_set_universe",
  () => supabase
    .from("card_printings")
    .select("set_name")
    .not("set_name", "is", null)
    .eq("language", "EN")
    .limit(20000),
);

if (setError) {
  console.error(`Failed to load set universe: ${setError.message}`);
  process.exit(1);
}

const setMap = new Map();
for (const row of setRows ?? []) {
  const setName = String(row.set_name ?? "").trim();
  if (!setName) continue;
  const setId = buildSetId(setName);
  if (!setId) continue;
  if (!setMap.has(setId)) {
    setMap.set(setId, { setId, setName });
  }
}

const setUniverse = [...setMap.values()].sort((left, right) => left.setName.localeCompare(right.setName));
const setBatches = chunk(setUniverse, setBatchSize);

console.log(JSON.stringify({
  step: "load_set_universe",
  sets: setUniverse.length,
  setBatchSize,
  batches: setBatches.length,
  days,
  lookbackDays,
}, null, 2));

if (includePipelineRefresh) {
  for (let batchIndex = 0; batchIndex < setBatches.length; batchIndex += 1) {
    const batch = setBatches[batchIndex];
    const batchSetIds = batch.map((row) => row.setId);
    const batchSetNames = batch.map((row) => row.setName);

    const { data: printings, error: printingsError } = await withRetry(
      `load_printings_batch_${batchIndex + 1}`,
      () => supabase
        .from("card_printings")
        .select("id")
        .in("set_name", batchSetNames)
        .eq("language", "EN")
        .limit(5000),
    );

    if (printingsError) {
      console.error(`Failed to load printings for batch ${batchIndex + 1}: ${printingsError.message}`);
      process.exit(1);
    }

    const printingIds = (printings ?? []).map((row) => row.id).filter(Boolean);
    let pipelineResult = null;

    if (printingIds.length > 0) {
      const IN_CHUNK_SIZE = 100;
      const idChunks = chunk(printingIds, IN_CHUNK_SIZE);
      const variantRows = [];
      for (let i = 0; i < idChunks.length; i += 1) {
        const { data: chunkRows, error: variantError } = await withRetry(
          `load_variant_keys_batch_${batchIndex + 1}_chunk_${i + 1}`,
          () => supabase
            .from("variant_metrics")
            .select("canonical_slug, variant_ref, provider, grade")
            .eq("provider", "JUSTTCG")
            .eq("grade", "RAW")
            .in("printing_id", idChunks[i])
            .limit(5000),
        );
        if (variantError) {
          console.error(`Failed to load variant keys for batch ${batchIndex + 1} chunk ${i + 1}: ${variantError.message}`);
          process.exit(1);
        }
        variantRows.push(...(chunkRows ?? []));
      }

      const keys = variantRows.map((row) => ({
        canonical_slug: row.canonical_slug,
        variant_ref: row.variant_ref,
        provider: row.provider,
        grade: row.grade,
      }));

      if (keys.length > 0) {
        const KEY_RPC_CHUNK_SIZE = 150;
        const keyChunks = chunk(keys, KEY_RPC_CHUNK_SIZE);
        for (let k = 0; k < keyChunks.length; k += 1) {
          const { data, error } = await withRetry(
            `refresh_pipeline_batch_${batchIndex + 1}_keys_${k + 1}_of_${keyChunks.length}`,
            () => supabase.rpc("refresh_set_summary_pipeline_for_variants", {
              keys: keyChunks[k],
              target_as_of_date: today,
              lookback_days: lookbackDays,
            }),
          );
          if (error) {
            console.error(`refresh_set_summary_pipeline_for_variants failed for batch ${batchIndex + 1} keys chunk ${k + 1}: ${error.message}`);
            process.exit(1);
          }
          pipelineResult = data;
          if (sleepMs > 0 && k < keyChunks.length - 1) await delay(sleepMs);
        }
      }
    }

    const { data: finishRows, error: finishError } = await withRetry(
      `refresh_finish_batch_${batchIndex + 1}`,
      () => supabase.rpc("refresh_set_finish_summary_latest", {
        only_set_ids: batchSetIds,
      }),
    );
    if (finishError) {
      console.error(`refresh_set_finish_summary_latest failed for batch ${batchIndex + 1}: ${finishError.message}`);
      process.exit(1);
    }

    const { data: snapshotRows, error: snapshotError } = await withRetry(
      `refresh_current_snapshots_batch_${batchIndex + 1}`,
      () => supabase.rpc("refresh_set_summary_snapshots", {
        target_as_of_date: today,
        only_set_ids: batchSetIds,
      }),
    );
    if (snapshotError) {
      console.error(`refresh_set_summary_snapshots failed for current batch ${batchIndex + 1}: ${snapshotError.message}`);
      process.exit(1);
    }

    console.log(JSON.stringify({
      step: "refresh_current_batch",
      batch: batchIndex + 1,
      totalBatches: setBatches.length,
      setIds: batchSetIds,
      pipelineResult,
      snapshotRows,
      finishRows,
    }, null, 2));

    if (sleepMs > 0) await delay(sleepMs);
  }
} else {
  console.log(JSON.stringify({
    step: "refresh_current_batch",
    skipped: true,
    warning: "Current latest/daily caches were not refreshed. Historical snapshots will reuse existing rollups only.",
  }, null, 2));
}

for (let offset = days - 1; offset >= 0; offset -= 1) {
  const asOfDate = new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (let batchIndex = 0; batchIndex < setBatches.length; batchIndex += 1) {
    const batchSetIds = setBatches[batchIndex].map((row) => row.setId);
    const { data, error } = await withRetry(
      `refresh_history_${asOfDate}_batch_${batchIndex + 1}`,
      () => supabase.rpc("refresh_set_summary_snapshots", {
        target_as_of_date: asOfDate,
        only_set_ids: batchSetIds,
      }),
    );

    if (error) {
      console.error(`refresh_set_summary_snapshots failed for ${asOfDate} batch ${batchIndex + 1}: ${error.message}`);
      process.exit(1);
    }

    console.log(JSON.stringify({
      step: "refresh_history_batch",
      asOfDate,
      batch: batchIndex + 1,
      totalBatches: setBatches.length,
      setIds: batchSetIds,
      rows: data,
    }, null, 2));

    if (sleepMs > 0) await delay(sleepMs);
  }
}
