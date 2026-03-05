#!/usr/bin/env node
/**
 * Import all Pokemon TCG sets into the DB by repeatedly calling the canonical
 * import endpoint. Each request processes up to 5 pages (maxPages cap); we
 * continue until the API returns done=true.
 *
 * Prerequisites:
 * - Dev server running: npm run dev (or set BASE_URL to your deployed app URL)
 * - .env.local has ADMIN_SECRET and the server has POKEMONTCG_API_KEY
 *
 * Usage (local; dev server must be running):
 *   npm run dev
 *   # in another terminal:
 *   npm run import:pokemontcg-all
 *
 * Usage (production):
 *   BASE_URL=https://popalpha.ai node scripts/import-all-pokemontcg-canonical.mjs
 */
import dotenv from "dotenv";
import { fetch, Agent } from "undici";

console.log("[import-all-pokemontcg] Starting...");

dotenv.config({ path: ".env.local" });

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET?.trim();
const PAGE_SIZE = 250;
const MAX_PAGES_PER_REQUEST = 1;
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — server may take long (slow API + DB)
const DELAY_MS = 800;

// Node's default fetch has a ~5 min headers timeout; use undici with longer timeouts so the request can wait for the server.
const fetchAgent = new Agent({
  headersTimeout: REQUEST_TIMEOUT_MS + 60_000,
  bodyTimeout: REQUEST_TIMEOUT_MS + 60_000,
});

if (!ADMIN_SECRET) {
  console.error("[import-all-pokemontcg] ERROR: ADMIN_SECRET is required in .env.local");
  process.exit(1);
}

console.log("[import-all-pokemontcg] Config ok, will call:", BASE_URL);

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importChunk(pageStart) {
  const url = `${BASE_URL}/api/admin/import/pokemontcg-canonical?pageStart=${pageStart}&maxPages=${MAX_PAGES_PER_REQUEST}&pageSize=${PAGE_SIZE}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const progressInterval = setInterval(() => {
    process.stdout.write(".");
  }, 8000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": ADMIN_SECRET,
      },
      signal: controller.signal,
      dispatcher: fetchAgent,
    });
  } catch (err) {
    clearInterval(progressInterval);
    clearTimeout(timeoutId);
    const code = err.cause?.code ?? err.code;
    const msg =
      code === "ECONNREFUSED"
        ? "Connection refused. Is the dev server running? Run: npm run dev"
        : err.name === "AbortError"
          ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Try reducing MAX_PAGES_PER_REQUEST (currently ${MAX_PAGES_PER_REQUEST}).`
          : code
            ? `fetch failed (${code}). ${err.message}`
            : err.message;
    throw new Error("Request failed: " + msg);
  } finally {
    clearInterval(progressInterval);
    clearTimeout(timeoutId);
    process.stdout.write("\n");
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Server returned non-JSON (status " + res.status + "). First 200 chars: " + text.slice(0, 200));
  }
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "HTTP " + res.status);
  }
  return body;
}

async function main() {
  console.log("Importing all Pokemon TCG sets (canonical cards + printings)...");
  console.log("BASE_URL:", BASE_URL);
  console.log("Page size:", PAGE_SIZE, "| Max pages per request:", MAX_PAGES_PER_REQUEST);
  console.log("");
  console.log("First request may take 1–2 minutes (fewer pages per round to avoid timeouts). Please wait...");
  console.log("");

  let pageStart = 1;
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalFailed = 0;
  let round = 0;

  while (true) {
    round += 1;
    try {
      console.log(`Round ${round}: requesting pageStart=${pageStart} (may take 1–3 min, dots every 8s)...`);
      const result = await importChunk(pageStart);
      const fetched = result.itemsFetched ?? 0;
      const upserted = result.itemsUpserted ?? 0;
      const failed = result.itemsFailed ?? 0;
      totalFetched += fetched;
      totalUpserted += upserted;
      totalFailed += failed;

      console.log(
        `Round ${round}  pageStart=${result.pageStart}  nextPageStart=${result.nextPageStart}  fetched=${fetched}  upserted=${upserted}  failed=${failed}  done=${result.done}`
      );

      if (result.done || (fetched === 0 && result.nextPageStart === pageStart)) {
        console.log("");
        console.log("Import complete.");
        console.log("Total items fetched:", totalFetched);
        console.log("Total items upserted:", totalUpserted);
        console.log("Total items failed:", totalFailed);
        break;
      }

      pageStart = result.nextPageStart;
      if (pageStart == null || pageStart < 1) {
        console.error("Unexpected nextPageStart:", result.nextPageStart);
        process.exit(1);
      }

      await delay(DELAY_MS);
    } catch (err) {
      console.error("Round", round, "failed:", err.message);
      process.exit(1);
    }
  }
}

main();
