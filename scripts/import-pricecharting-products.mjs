#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { parsePriceChartingCsv } from "../lib/backfill/pricecharting-normalize.ts";
import { runPriceChartingIngest } from "../lib/backfill/pricecharting-ingest.ts";

dotenv.config({ path: ".env.local", quiet: true });

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function readCsvText() {
  const csvFile = argValue("csv-file");
  const csvUrl = argValue("csv-url");
  if (csvFile && csvUrl) throw new Error("Pass only one of --csv-file or --csv-url");

  if (csvFile) {
    return fs.readFile(path.resolve(csvFile), "utf8");
  }

  if (!csvUrl) return null;
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`PriceCharting CSV fetch failed: HTTP ${res.status}`);
  return res.text();
}

async function readApiJsonRecords() {
  const jsonFile = argValue("json-file");
  const apiProductId = argValue("api-product-id");
  const apiQuery = argValue("api-query");
  const selected = [jsonFile, apiProductId, apiQuery].filter(Boolean);
  if (selected.length > 1) {
    throw new Error("Pass only one of --json-file, --api-product-id, or --api-query");
  }

  if (jsonFile) {
    const raw = await fs.readFile(path.resolve(jsonFile), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  }

  if (!apiProductId && !apiQuery) return null;
  const token = requireEnv("PRICECHARTING_TOKEN");
  const url = new URL("https://www.pricecharting.com/api/product");
  url.searchParams.set("t", token);
  if (apiProductId) url.searchParams.set("id", apiProductId);
  if (apiQuery) url.searchParams.set("q", apiQuery);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`PriceCharting API fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.status && body.status !== "success") {
    throw new Error(`PriceCharting API returned status=${body.status}`);
  }
  return [body];
}

async function loadPriceChartingRecords() {
  const csvText = await readCsvText();
  const apiRecords = await readApiJsonRecords();
  if (csvText && apiRecords) {
    throw new Error("Pass either a CSV input or an API JSON input, not both");
  }
  if (csvText) {
    return {
      importSource: "csv",
      records: parsePriceChartingCsv(csvText),
    };
  }
  if (apiRecords) {
    return {
      importSource: "api",
      records: apiRecords,
    };
  }
  throw new Error("Pass --csv-file, --csv-url, --json-file, --api-product-id, or --api-query");
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const { importSource, records } = await loadPriceChartingRecords();

  // Dry run needs no DB credentials — it just reports what WOULD be written.
  const supabase = dryRun
    ? null
    : createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { autoRefreshToken: false, persistSession: false },
      });

  const summary = await runPriceChartingIngest({
    supabase,
    records,
    importSource,
    observedAt: argValue("observed-at", new Date().toISOString()),
    dryRun,
    match: hasFlag("match"),
    refreshParity: hasFlag("refresh-parity"),
    skipProductUpsert: hasFlag("skip-products") || hasFlag("skip-product-upsert"),
    skipObservationUpsert: hasFlag("skip-observations") || hasFlag("skip-observation-upsert"),
    skipPrintingResolution: hasFlag("skip-printings") || hasFlag("skip-printing-resolution"),
    upsertBatchSize: positiveIntegerEnv("PRICECHARTING_UPSERT_BATCH_SIZE", undefined),
    matchBatchSize: positiveIntegerEnv("PRICECHARTING_MATCH_BATCH_SIZE", undefined),
    writeRetryAttempts: positiveIntegerEnv("PRICECHARTING_WRITE_RETRY_ATTEMPTS", undefined),
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
