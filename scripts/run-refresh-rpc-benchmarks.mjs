#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_SIZES = [25, 100, 400];
const DEFAULT_WINDOW_DAYS = 30;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseSizesArg(argv) {
  const raw = argv.find((arg) => arg.startsWith("--sizes="));
  if (!raw) return DEFAULT_SIZES;

  const sizes = raw
    .slice("--sizes=".length)
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  return sizes.length ? sizes : DEFAULT_SIZES;
}

function parseStringArg(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseIntArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeData(data) {
  if (Array.isArray(data)) {
    return {
      kind: "array",
      length: data.length,
      sample: data.slice(0, 3),
    };
  }

  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    const sample = {};
    for (const key of keys.slice(0, 6)) {
      sample[key] = data[key];
    }
    return {
      kind: "object",
      keys,
      sample,
    };
  }

  return {
    kind: typeof data,
    value: data ?? null,
  };
}

async function fetchScope(supabase, size) {
  const { data, error } = await supabase
    .from("card_metrics")
    .select("canonical_slug,market_price_as_of")
    .eq("grade", "RAW")
    .is("printing_id", null)
    .not("market_price_as_of", "is", null)
    .order("market_price_as_of", { ascending: false })
    .order("canonical_slug", { ascending: true })
    .limit(size);

  if (error) throw new Error(`card_metrics(scope ${size}): ${error.message}`);
  return (data ?? []).map((row) => String(row.canonical_slug));
}

async function timeRpc(supabase, name, params) {
  const startedAt = performance.now();
  const { data, error } = await supabase.rpc(name, params);
  const executionMs = round(performance.now() - startedAt);
  if (error) throw new Error(`${name}: ${error.message}`);
  return {
    executionMs,
    result: summarizeData(data),
  };
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sizes = parseSizesArg(process.argv);
  const outputArg = parseStringArg(process.argv, "out");
  const windowDays = parseIntArg(process.argv, "window-days", DEFAULT_WINDOW_DAYS);
  const outputPath = outputArg || path.join("/tmp", `popalpha-refresh-rpc-benchmarks-${Date.now()}.json`);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const benchmarkFns = [
    {
      name: "refresh_card_metrics_for_variants",
      buildParams: (slugs) => ({ keys: slugs.map((canonical_slug) => ({ canonical_slug })) }),
    },
    {
      name: "refresh_price_changes_for_cards",
      buildParams: (slugs) => ({ p_canonical_slugs: slugs }),
    },
    {
      name: "refresh_card_market_confidence_for_cards",
      buildParams: (slugs) => ({ p_canonical_slugs: slugs }),
    },
    {
      name: "refresh_canonical_raw_provider_parity_for_cards",
      buildParams: (slugs) => ({ p_canonical_slugs: slugs, p_window_days: windowDays }),
    },
  ];

  const artifact = {
    generatedAt: new Date().toISOString(),
    outputPath,
    sizes,
    windowDays,
    transport: "supabase-js-rpc",
    cohorts: [],
  };

  for (const size of sizes) {
    const slugs = await fetchScope(supabase, size);
    const cohort = {
      size,
      slugCount: slugs.length,
      firstSlug: slugs[0] ?? null,
      lastSlug: slugs.at(-1) ?? null,
      functions: [],
    };

    for (const benchmarkFn of benchmarkFns) {
      const result = await timeRpc(supabase, benchmarkFn.name, benchmarkFn.buildParams(slugs));
      cohort.functions.push({
        name: benchmarkFn.name,
        ...result,
      });
      console.log(JSON.stringify({
        cohort: size,
        function: benchmarkFn.name,
        executionMs: result.executionMs,
        result: result.result,
      }));
    }

    artifact.cohorts.push(cohort);
    console.log(JSON.stringify({ cohort: size, slugCount: cohort.slugCount, completed: true }));
  }

  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ ok: true, outputPath, sizes }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
