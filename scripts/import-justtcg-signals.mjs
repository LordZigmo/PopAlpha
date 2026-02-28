import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const cronSecret = process.env.CRON_SECRET;

if (!cronSecret) {
  console.error("CRON_SECRET is required.");
  process.exit(1);
}

const args = process.argv.slice(2);
const setArg = args.find((arg) => arg.startsWith("--set="));
const setId = setArg ? setArg.slice("--set=".length) : null;
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const debugLimit = limitArg ? limitArg.slice("--limit=".length) : null;
const force = !args.includes("--no-force");

async function callJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function runOnce(syncUrl) {
  const syncResult = await callJson(syncUrl);
  const refreshResult = await callJson(`${baseUrl}/api/cron/refresh-derived-signals`);
  return { syncResult, refreshResult };
}

async function main() {
  if (setId) {
    const params = new URLSearchParams({ set: setId });
    if (debugLimit) params.set("limit", debugLimit);
    if (force) params.set("force", "1");
    const { syncResult, refreshResult } = await runOnce(`${baseUrl}/api/cron/sync-justtcg-prices?${params.toString()}`);
    console.log(JSON.stringify({ mode: "debug-set", syncResult, refreshResult }, null, 2));
    return;
  }

  const runs = [];
  for (;;) {
    const params = new URLSearchParams();
    if (force) params.set("force", "1");
    const { syncResult, refreshResult } = await runOnce(`${baseUrl}/api/cron/sync-justtcg-prices?${params.toString()}`);
    runs.push({
      setsProcessed: syncResult.setsProcessed ?? null,
      done: Boolean(syncResult.done),
      itemsFetched: syncResult.itemsFetched ?? null,
      variantMetricsWritten: syncResult.variantMetricsWritten ?? null,
      rowsUpdated: refreshResult.rowsUpdated ?? null,
      firstError: syncResult.firstError ?? null,
    });

    if (syncResult.done) break;
  }

  fs.writeFileSync(
    path.join(process.cwd(), "scripts", "import-justtcg-signals.last.json"),
    JSON.stringify(runs, null, 2),
  );
  console.log(JSON.stringify({ mode: "full-sync", runs }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
