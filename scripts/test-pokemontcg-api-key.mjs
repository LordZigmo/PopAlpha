#!/usr/bin/env node
/**
 * Test that POKEMONTCG_API_KEY from .env.local works with the official Pokemon TCG API.
 * Run from project root: node scripts/test-pokemontcg-api-key.mjs
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env.local");
dotenv.config({ path: envPath });

const key = process.env.POKEMONTCG_API_KEY?.trim();
if (!key) {
  console.error("POKEMONTCG_API_KEY not set in .env.local");
  process.exit(1);
}

const url = "https://api.pokemontcg.io/v2/sets?pageSize=1";
console.log("Requesting", url, "with X-Api-Key (length", key.length, ")...");

const res = await fetch(url, {
  headers: { "X-Api-Key": key },
});
const status = res.status;
const text = await res.text();

console.log("HTTP status:", status);
if (status === 200) {
  console.log("OK – key is valid. You can run the import.");
} else {
  console.log("Response:", text.slice(0, 300));
  if (status === 404) {
    console.error("404 = key rejected. Use a key from https://dev.pokemontcg.io/ (not RapidAPI).");
  }
  process.exit(1);
}
