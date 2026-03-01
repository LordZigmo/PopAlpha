#!/usr/bin/env node
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_SECRET ?? "";

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

if (!CRON_SECRET) {
  console.error("Missing CRON_SECRET in environment.");
  process.exit(1);
}

const providerSetId = parseArg("set", "base-set-pokemon");
const slug = parseArg("slug", "");
const printingId = parseArg("printing", "");

if (!slug || !printingId) {
  console.error("Usage: node scripts/verify-market-summary-cache.mjs --slug=<canonical_slug> --printing=<uuid> [--set=<provider_set_id>]");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${CRON_SECRET}` };

const syncUrl = new URL(`${APP_URL}/api/cron/sync-justtcg-prices`);
syncUrl.searchParams.set("set", providerSetId);
syncUrl.searchParams.set("limit", "1");
syncUrl.searchParams.set("force", "1");

const syncResponse = await fetch(syncUrl, { headers });
const syncPayload = await syncResponse.json();

const debugUrl = new URL(`${APP_URL}/api/debug/market-summary`);
debugUrl.searchParams.set("slug", slug);
debugUrl.searchParams.set("printing_id", printingId);

const debugResponse = await fetch(debugUrl, { headers });
const debugPayload = await debugResponse.json();

const ok =
  syncResponse.ok
  && debugResponse.ok
  && debugPayload?.market_latest?.exists
  && debugPayload?.variant_metrics?.exists
  && (debugPayload?.price_history_points?.count ?? 0) > 0;

console.log(JSON.stringify({
  ok,
  sync: syncPayload,
  debug: debugPayload,
}, null, 2));

if (!ok) process.exit(1);
