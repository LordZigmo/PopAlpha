import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const statePath = path.resolve(process.cwd(), "scripts", "unknown-finish-watch-state.json");

async function readState() {
  try {
    const content = await fs.readFile(statePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { lastCheckedAt: "1970-01-01T00:00:00.000Z" };
    }
    throw error;
  }
}

async function writeState(state) {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function run() {
  const state = await readState();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, card_number, set_code, set_name, source, source_id, created_at")
    .eq("finish", "UNKNOWN")
    .gt("created_at", state.lastCheckedAt)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const added = data ?? [];
  if (added.length === 0) {
    console.log(`No new UNKNOWN finishes since ${state.lastCheckedAt}.`);
  } else {
    console.log(`Detected ${added.length} new UNKNOWN finishes (since ${state.lastCheckedAt}):`);
    for (const row of added) {
      console.log(
        `  ${row.set_code ?? "unknown"} #${row.card_number ?? "?"} ${row.canonical_slug} (@${row.created_at})`,
      );
    }
  }

  await writeState({ lastCheckedAt: now });
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
