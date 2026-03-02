import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

if (!CRON_SECRET) {
  throw new Error("Missing CRON_SECRET");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function parseArgs(argv) {
  const options = {
    maxSets: 25,
    passes: 1,
    offset: 0,
    minUnknown: 1,
    maxUnknown: Number.POSITIVE_INFINITY,
    sleepMs: 250,
    retryCount: 2,
    baseUrl: resolveBaseUrl(),
    sort: "desc",
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, rawValue = ""] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();
    const value = rawValue.trim();

    if (key === "max-sets" && value) options.maxSets = Math.max(1, Number.parseInt(value, 10) || options.maxSets);
    if (key === "passes" && value) options.passes = Math.max(1, Number.parseInt(value, 10) || options.passes);
    if (key === "offset" && value) options.offset = Math.max(0, Number.parseInt(value, 10) || options.offset);
    if (key === "min-unknown" && value) options.minUnknown = Math.max(1, Number.parseInt(value, 10) || options.minUnknown);
    if (key === "max-unknown" && value) options.maxUnknown = Math.max(options.minUnknown, Number.parseInt(value, 10) || options.maxUnknown);
    if (key === "sleep-ms" && value) options.sleepMs = Math.max(0, Number.parseInt(value, 10) || options.sleepMs);
    if (key === "retry-count" && value) options.retryCount = Math.max(0, Number.parseInt(value, 10) || options.retryCount);
    if (key === "base-url" && value) options.baseUrl = value.replace(/\/$/, "");
    if (key === "sort" && (value === "asc" || value === "desc")) options.sort = value;
  }

  return options;
}

function resolveBaseUrl() {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod}`;

  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment) return `https://${deployment}`;

  return "http://localhost:3000";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUnknownTotal() {
  const { count, error } = await supabase
    .from("card_printings")
    .select("id", { count: "exact", head: true })
    .eq("language", "EN")
    .eq("finish", "UNKNOWN");

  if (error) throw new Error(`Count UNKNOWN printings failed: ${error.message}`);
  return Number(count ?? 0);
}

async function loadUnknownSets(options) {
  const totalUnknown = await getUnknownTotal();
  const pageSize = 1000;
  const bySet = new Map();

  for (let from = 0; from < totalUnknown; from += pageSize) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("set_code,set_name")
      .eq("language", "EN")
      .eq("finish", "UNKNOWN")
      .not("set_code", "is", null)
      .not("set_name", "is", null)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Load UNKNOWN printings failed: ${error.message}`);

    for (const row of data ?? []) {
      const setCode = String(row.set_code ?? "").trim();
      const setName = String(row.set_name ?? "").trim();
      if (!setCode || !setName) continue;

      const existing = bySet.get(setCode) ?? { setCode, setName, unknownCount: 0 };
      existing.unknownCount += 1;
      bySet.set(setCode, existing);
    }
  }

  return [...bySet.values()]
    .filter((row) => row.unknownCount >= options.minUnknown && row.unknownCount <= options.maxUnknown)
    .sort((a, b) => {
      if (options.sort === "asc") {
        return a.unknownCount - b.unknownCount || a.setName.localeCompare(b.setName);
      }
      return b.unknownCount - a.unknownCount || a.setName.localeCompare(b.setName);
    });
}

async function callRepair(baseUrl, target, retryCount) {
  const url = new URL("/api/debug/justtcg/repair-set-finishes", baseUrl);
  url.searchParams.set("setCode", target.setCode);
  url.searchParams.set("setName", target.setName);

  let lastError = null;

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt <= retryCount) {
        await sleep(750 * attempt);
      }
    }
  }

  throw lastError ?? new Error("Unknown repair failure");
}

function summarizePass(results) {
  return results.reduce((acc, row) => {
    acc.sets += 1;
    acc.selected += Number(row.selected ?? 0);
    acc.updatedInPlace += Number(row.updatedInPlace ?? 0);
    acc.insertedVariants += Number(row.insertedVariants ?? 0);
    acc.skipped += Number(row.skipped ?? 0);
    if (Number(row.updatedInPlace ?? 0) > 0 || Number(row.insertedVariants ?? 0) > 0) {
      acc.changedSets += 1;
    }
    return acc;
  }, {
    sets: 0,
    changedSets: 0,
    selected: 0,
    updatedInPlace: 0,
    insertedVariants: 0,
    skipped: 0,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const beforeTotal = await getUnknownTotal();
  console.log(
    `[start] baseUrl=${options.baseUrl} maxSets=${options.maxSets} passes=${options.passes} offset=${options.offset} minUnknown=${options.minUnknown} maxUnknown=${Number.isFinite(options.maxUnknown) ? options.maxUnknown : "inf"} sort=${options.sort} beforeUnknown=${beforeTotal}`,
  );

  const allPasses = [];

  for (let pass = 1; pass <= options.passes; pass += 1) {
    const unknownSets = await loadUnknownSets(options);
    const targets = unknownSets.slice(options.offset, options.offset + options.maxSets);
    if (targets.length === 0) {
      console.log(`[pass ${pass}] No sets matched the current filter.`);
      break;
    }

    console.log(`[pass ${pass}] queuedSets=${targets.length} topSet=${targets[0].setCode}:${targets[0].unknownCount}`);
    const passResults = [];

    for (const [index, target] of targets.entries()) {
      const position = index + 1;
      console.log(`[pass ${pass}] ${position}/${targets.length} ${target.setCode} "${target.setName}" unknown=${target.unknownCount}`);

      try {
        const payload = await callRepair(options.baseUrl, target, options.retryCount);
        passResults.push({
          setCode: target.setCode,
          setName: target.setName,
          unknownBefore: target.unknownCount,
          selected: Number(payload?.selected ?? 0),
          updatedInPlace: Number(payload?.updatedInPlace ?? 0),
          insertedVariants: Number(payload?.insertedVariants ?? 0),
          skipped: Number(payload?.skipped ?? 0),
        });
        console.log(
          `[pass ${pass}] done ${target.setCode} selected=${payload?.selected ?? 0} updated=${payload?.updatedInPlace ?? 0} inserted=${payload?.insertedVariants ?? 0} skipped=${payload?.skipped ?? 0}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        passResults.push({
          setCode: target.setCode,
          setName: target.setName,
          unknownBefore: target.unknownCount,
          selected: 0,
          updatedInPlace: 0,
          insertedVariants: 0,
          skipped: target.unknownCount,
          error: message,
        });
        console.error(`[pass ${pass}] failed ${target.setCode}: ${message}`);
      }

      if (options.sleepMs > 0 && position < targets.length) {
        await sleep(options.sleepMs);
      }
    }

    const summary = summarizePass(passResults);
    allPasses.push({ pass, summary, results: passResults });
    console.log(
      `[pass ${pass}] summary sets=${summary.sets} changedSets=${summary.changedSets} selected=${summary.selected} updated=${summary.updatedInPlace} inserted=${summary.insertedVariants} skipped=${summary.skipped}`,
    );
  }

  const afterTotal = await getUnknownTotal();
  const delta = beforeTotal - afterTotal;
  console.log(`[done] beforeUnknown=${beforeTotal} afterUnknown=${afterTotal} reducedBy=${delta}`);

  const failed = allPasses.flatMap((entry) => entry.results.filter((row) => row.error));
  if (failed.length > 0) {
    console.log("[failed]");
    for (const row of failed) {
      console.log(`- ${row.setCode}: ${row.error}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
