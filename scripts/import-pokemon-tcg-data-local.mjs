import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env.local");
const statePath = path.join(__dirname, "import-state.json");

const BATCH_SIZE = 250;
const SUPABASE_REQUEST_TIMEOUT_MS = 30_000;
const UPDATE_CONCURRENCY = 10;

function loadEnvFile(filePath) {
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false });
  }
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveDataRoot() {
  const candidates = [
    path.join(projectRoot, "data", "pokemon-tcg-data"),
    path.join(projectRoot, "pokemon-tcg-data"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find pokemon-tcg-data under data/ or project root.");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function slugify(input) {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 200);
}

function normalizeAlias(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripPunctuation(value) {
  return normalizeAlias(value).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseYear(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseCardNumber(rawNumber) {
  const trimmed = String(rawNumber ?? "").trim();
  const slashMatch = trimmed.match(/^#?\s*(\d+)\s*\/\s*\d+/i);
  if (slashMatch) return { full: trimmed, leading: slashMatch[1] };
  const digits = trimmed.match(/^#?\s*(\d+)/);
  if (digits) return { full: trimmed, leading: digits[1] };
  return { full: trimmed, leading: trimmed };
}

function extractSubject(name) {
  const prefixes = [
    /^team rocket's\s+/i,
    /^blaine's\s+/i,
    /^brock's\s+/i,
    /^misty's\s+/i,
    /^erika's\s+/i,
    /^giovanni's\s+/i,
    /^lt\.\s*surge's\s+/i,
    /^dark\s+/i,
    /^light\s+/i,
  ];
  let working = String(name ?? "").trim();
  for (const prefix of prefixes) {
    working = working.replace(prefix, "");
  }
  working = working
    .replace(/\s+(ex|gx|vmax|vstar|v|lv\.x)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return working || String(name ?? "").trim();
}

function inferFinish(card) {
  const rarity = String(card.rarity ?? "").toLowerCase();
  if (rarity.includes("reverse")) return { finish: "REVERSE_HOLO", variantKey: "reverse", finishDetail: null };
  if (rarity.includes("holo")) return { finish: "HOLO", variantKey: "holo", finishDetail: null };
  return { finish: "UNKNOWN", variantKey: "unknown", finishDetail: null };
}

function inferEdition(card) {
  const legalities = card.legalities ?? {};
  if (legalities.firstEdition) return "FIRST_EDITION";
  return "UNLIMITED";
}

function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) {
    out.push(array.slice(index, index + size));
  }
  return out;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input, init) {
  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), SUPABASE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function retryAsync(fn, label, maxAttempts = 5) {
  let attempt = 1;
  while (attempt <= maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts) {
        throw new Error(`${label} failed after ${attempt} attempts: ${message}`);
      }
      const delayMs = Math.min(5000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
      console.warn(`${label} attempt ${attempt} failed: ${message}. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

function dedupeByConflict(rows, onConflict) {
  const keys = String(onConflict)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (keys.length === 0) return rows;

  const map = new Map();
  for (const row of rows) {
    const dedupeKey = keys.map((key) => JSON.stringify(row[key] ?? null)).join("|");
    map.set(dedupeKey, row);
  }
  return Array.from(map.values());
}

function loadState() {
  if (!fs.existsSync(statePath)) {
    return {
      lastProcessedCardFileIndex: -1,
      lastProcessedDeckFileIndex: -1,
    };
  }
  try {
    const parsed = readJson(statePath);
    return {
      lastProcessedCardFileIndex:
        typeof parsed.lastProcessedCardFileIndex === "number" ? parsed.lastProcessedCardFileIndex : -1,
      lastProcessedDeckFileIndex:
        typeof parsed.lastProcessedDeckFileIndex === "number" ? parsed.lastProcessedDeckFileIndex : -1,
    };
  } catch {
    return {
      lastProcessedCardFileIndex: -1,
      lastProcessedDeckFileIndex: -1,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function upsertBatches(supabase, table, rows, onConflict) {
  let processed = 0;
  const batches = chunk(rows, BATCH_SIZE);
  console.log(`[${table}] Starting ${rows.length} rows across ${batches.length} batch(es)`);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchRows = batches[batchIndex];
    const dedupedRows = dedupeByConflict(batchRows, onConflict);
    console.log(`[${table}] Batch ${batchIndex + 1}/${batches.length}: ${dedupedRows.length} deduped row(s)`);
    const result = await retryAsync(async () => {
      const { error } = await supabase.from(table).upsert(dedupedRows, { onConflict });
      if (error) {
        throw new Error(error.message);
      }
      return { ok: true };
    }, `${table} upsert`);
    if (!result?.ok) {
      throw new Error(`${table} upsert failed`);
    }
    processed += dedupedRows.length;
    console.log(`[${table}] Batch ${batchIndex + 1}/${batches.length} complete (${processed}/${rows.length})`);
  }
  return processed;
}

async function findExistingPrintingRow(supabase, row) {
  let uniqueQuery = supabase
    .from("card_printings")
    .select("id, source_id")
    .eq("card_number", row.card_number)
    .eq("language", row.language)
    .eq("finish", row.finish)
    .eq("edition", row.edition);

  uniqueQuery = row.set_code ? uniqueQuery.eq("set_code", row.set_code) : uniqueQuery.is("set_code", null);
  uniqueQuery = row.stamp ? uniqueQuery.eq("stamp", row.stamp) : uniqueQuery.is("stamp", null);
  uniqueQuery = row.finish_detail
    ? uniqueQuery.eq("finish_detail", row.finish_detail)
    : uniqueQuery.is("finish_detail", null);

  const { data, error } = await uniqueQuery.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function isUniquePrintingConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("card_printings_unique_printing_idx");
}

// Fallback: handles one row when a batch insert hits a conflict.
async function syncSingleCardPrinting(supabase, row) {
  const existingBySourceId = await retryAsync(async () => {
    const { data, error } = await supabase
      .from("card_printings")
      .select("id, source_id")
      .eq("source", "pokemon-tcg-data")
      .eq("source_id", row.source_id)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }, "card_printings select by source_id");

  if (existingBySourceId?.id) {
    await retryAsync(async () => {
      const { error } = await supabase.from("card_printings").update(row).eq("id", existingBySourceId.id);
      if (error) throw new Error(error.message);
    }, "card_printings update");
    return { id: existingBySourceId.id, source_id: row.source_id };
  }

  // Insert without retrying — a unique conflict is not transient
  const { data: insertedData, error: insertError } = await supabase
    .from("card_printings")
    .insert(row)
    .select("id, source_id")
    .single();
  if (!insertError) return insertedData;
  if (!isUniquePrintingConflict(insertError instanceof Error ? insertError : new Error(String(insertError)))) {
    throw new Error(insertError instanceof Error ? insertError.message : String(insertError));
  }

  // Unique conflict: find the existing row by natural key and update it
  const collidedRow = await retryAsync(() => findExistingPrintingRow(supabase, row), "card_printings reselect after conflict");
  if (!collidedRow?.id) throw new Error(insertError instanceof Error ? insertError.message : String(insertError));
  await retryAsync(async () => {
    const { error: updateError } = await supabase.from("card_printings").update(row).eq("id", collidedRow.id);
    if (updateError) throw new Error(updateError.message);
  }, "card_printings update after conflict");
  return { id: collidedRow.id, source_id: row.source_id };
}

async function syncCardPrintings(supabase, rows) {
  console.log(`[card_printings] Fast-syncing ${rows.length} row(s)`);

  // 1. One batch SELECT to find which source_ids already exist
  const sourceIds = rows.map((r) => r.source_id);
  const existingMap = new Map(); // source_id → id
  for (const idChunk of chunk(sourceIds, 1000)) {
    const { data, error } = await retryAsync(async () => {
      const result = await supabase
        .from("card_printings")
        .select("id, source_id")
        .eq("source", "pokemon-tcg-data")
        .in("source_id", idChunk);
      if (result.error) throw new Error(result.error.message);
      return result;
    }, "card_printings batch-select existing");
    for (const row of data ?? []) existingMap.set(row.source_id, row.id);
  }

  const toUpdate = rows.filter((r) => existingMap.has(r.source_id));
  const toInsert = rows.filter((r) => !existingMap.has(r.source_id));
  console.log(`[card_printings] ${toUpdate.length} to update, ${toInsert.length} to insert`);

  const resolvedRows = [];

  // 2. Parallel updates (UPDATE_CONCURRENCY at a time)
  for (const updateChunk of chunk(toUpdate, UPDATE_CONCURRENCY)) {
    const results = await Promise.all(
      updateChunk.map(async (row) => {
        const id = existingMap.get(row.source_id);
        await retryAsync(async () => {
          const { error } = await supabase.from("card_printings").update(row).eq("id", id);
          if (error) throw new Error(error.message);
        }, `card_printings update ${row.source_id}`);
        return { id, source_id: row.source_id };
      })
    );
    resolvedRows.push(...results);
  }

  // 3. Batch inserts; fall back to one-by-one if the batch hits a conflict
  for (const insertChunk of chunk(toInsert, BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("card_printings")
      .insert(insertChunk)
      .select("id, source_id");

    if (!error && data) {
      resolvedRows.push(...data);
      continue;
    }

    // One row in this batch conflicts with the natural unique index — handle individually
    console.warn(`[card_printings] Batch insert failed (${error?.message ?? "unknown"}), retrying ${insertChunk.length} rows one-by-one`);
    for (const row of insertChunk) {
      const synced = await syncSingleCardPrinting(supabase, row);
      if (synced) resolvedRows.push(synced);
    }
  }

  return resolvedRows;
}

async function main() {
  loadEnvFile(envPath);
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const supabaseKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      fetch: fetchWithTimeout,
    },
  });

  const dataRoot = resolveDataRoot();
  const cardsDir = path.join(dataRoot, "cards", "en");
  const decksDir = path.join(dataRoot, "decks", "en");
  const setsPath = path.join(dataRoot, "sets", "en.json");

  const setRows = fs.existsSync(setsPath) ? readJson(setsPath) : [];
  const setYearMap = new Map();
  for (const setRow of setRows) {
    if (setRow?.id) {
      setYearMap.set(setRow.id, {
        year: parseYear(setRow.releaseDate),
        name: setRow.name ?? null,
      });
    }
  }

  const cardFiles = fs
    .readdirSync(cardsDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  const deckFiles = fs
    .readdirSync(decksDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  const state = loadState();
  const counts = {
    cardFilesProcessed: 0,
    deckFilesProcessed: 0,
    cardsUpserted: 0,
    printingsUpserted: 0,
    decksUpserted: 0,
    deckCardsUpserted: 0,
  };

  console.log(`Using data root: ${dataRoot}`);
  console.log(`Resuming cards from file index ${state.lastProcessedCardFileIndex + 1}`);

  for (let cardFileIndex = state.lastProcessedCardFileIndex + 1; cardFileIndex < cardFiles.length; cardFileIndex += 1) {
    const fileName = cardFiles[cardFileIndex];
    const filePath = path.join(cardsDir, fileName);
    const cards = readJson(filePath);
    console.log(`Processing card file ${cardFileIndex + 1}/${cardFiles.length}: ${fileName} (${cards.length} cards)`);

    const canonicalRows = [];
    const printingRows = [];
    const printingAliasRows = [];
    const cardAliasRows = [];

    for (const card of cards) {
      const setCode = String(card.id ?? "").split("-")[0];
      const setMeta = setYearMap.get(setCode) ?? { year: null, name: path.basename(fileName, ".json") };
      const setName = setMeta.name ?? null;
      const year = setMeta.year ?? null;
      const numberBits = parseCardNumber(card.number);
      const canonicalName = String(card.name ?? "").trim();
      const subject = extractSubject(canonicalName);
      const slug = slugify(`${setName ?? "unknown-set"}-${numberBits.leading}-${canonicalName}`) || slugify(String(card.id));
      const finishBits = inferFinish(card);
      const edition = inferEdition(card);
      const imageUrl = card.images?.large ?? card.images?.small ?? null;
      const sourceId = `${card.id}:${finishBits.finish}:${edition}:${finishBits.variantKey}`;

      canonicalRows.push({
        slug,
        canonical_name: canonicalName,
        subject: subject || null,
        set_name: setName,
        year,
        card_number: numberBits.leading || null,
        language: "EN",
        variant: null,
      });

      printingRows.push({
        canonical_slug: slug,
        set_name: setName,
        set_code: setCode || null,
        year,
        card_number: numberBits.leading || numberBits.full,
        language: "EN",
        finish: finishBits.finish,
        finish_detail: finishBits.finishDetail,
        edition,
        stamp: null,
        rarity: card.rarity ?? null,
        image_url: imageUrl,
        source: "pokemon-tcg-data",
        source_id: sourceId,
      });

      const printingAliases = new Set([
        normalizeAlias(`${canonicalName} ${setName ?? ""} ${numberBits.full}`),
        normalizeAlias(`${setName ?? ""} ${numberBits.full}`),
        normalizeAlias(`#${numberBits.full}`),
        normalizeAlias(`##${numberBits.full}`),
      ]);
      if (numberBits.leading && numberBits.leading !== numberBits.full) {
        printingAliases.add(normalizeAlias(`${canonicalName} ${setName ?? ""} ${numberBits.leading}`));
        printingAliases.add(normalizeAlias(`${setName ?? ""} ${numberBits.leading}`));
        printingAliases.add(normalizeAlias(`#${numberBits.leading}`));
        printingAliases.add(normalizeAlias(`##${numberBits.leading}`));
      }
      for (const alias of printingAliases) {
        if (!alias) continue;
        printingAliasRows.push({
          alias,
          printing_id: null,
          __source_id: sourceId,
        });
      }

      const canonicalAliases = new Set([normalizeAlias(canonicalName)]);
      if (subject && normalizeAlias(subject) !== normalizeAlias(canonicalName)) {
        canonicalAliases.add(normalizeAlias(subject));
      }
      for (const alias of canonicalAliases) {
        if (!alias) continue;
        cardAliasRows.push({
          alias,
          canonical_slug: slug,
        });
      }
    }

    console.log(`[${fileName}] Upserting canonical_cards`);
    counts.cardsUpserted += await upsertBatches(supabase, "canonical_cards", canonicalRows, "slug");

    console.log(`[${fileName}] Syncing card_printings`);
    const printingIdBySourceId = new Map();
    const syncedPrintings = await syncCardPrintings(supabase, printingRows);
    counts.printingsUpserted += printingRows.length;
    for (const row of syncedPrintings) {
      if (row?.source_id && row?.id) {
        printingIdBySourceId.set(row.source_id, row.id);
      }
    }

    const resolvedPrintingAliases = printingAliasRows
      .map((row) => {
        const printingId = printingIdBySourceId.get(row.__source_id);
        if (!printingId) return null;
        return {
          alias: row.alias,
          printing_id: printingId,
        };
      })
      .filter(Boolean);

    if (resolvedPrintingAliases.length > 0) {
      console.log(`[${fileName}] Upserting printing_aliases (${resolvedPrintingAliases.length})`);
      await upsertBatches(supabase, "printing_aliases", resolvedPrintingAliases, "alias");
    }

    if (cardAliasRows.length > 0) {
      console.log(`[${fileName}] Upserting card_aliases (${cardAliasRows.length})`);
      await upsertBatches(supabase, "card_aliases", cardAliasRows, "alias,canonical_slug");
    }

    counts.cardFilesProcessed += 1;
    state.lastProcessedCardFileIndex = cardFileIndex;
    saveState(state);
    console.log(`[${fileName}] Completed. State saved at card index ${state.lastProcessedCardFileIndex}`);
  }

  console.log(`Resuming decks from file index ${state.lastProcessedDeckFileIndex + 1}`);

  for (let deckFileIndex = state.lastProcessedDeckFileIndex + 1; deckFileIndex < deckFiles.length; deckFileIndex += 1) {
    const fileName = deckFiles[deckFileIndex];
    const filePath = path.join(decksDir, fileName);
    const decks = readJson(filePath);
    console.log(`Processing deck file ${deckFileIndex + 1}/${deckFiles.length}: ${fileName} (${decks.length} decks)`);

    const deckRows = [];
    const deckAliasRows = [];
    const deckCardRows = [];

    for (const deck of decks) {
      const deckId = String(deck.id ?? path.basename(fileName, ".json")).trim();
      const deckName = String(deck.name ?? deckId).trim();
      const releaseYear = parseYear(deck.releaseDate) ?? null;
      const imageUrl = deck.image ?? deck.images?.logo ?? null;
      deckRows.push({
        id: deckId,
        name: deckName,
        format: deck.format ?? null,
        release_year: releaseYear,
        source: "pokemon-tcg-data",
        source_id: deckId,
        image_url: imageUrl,
        raw: deck,
      });

      const aliasSet = new Set([normalizeAlias(deckName), stripPunctuation(deckName)]);
      for (const alias of aliasSet) {
        if (!alias) continue;
        deckAliasRows.push({
          alias,
          deck_id: deckId,
        });
      }

      for (const line of deck.cards ?? []) {
        const cardSourceId = String(line.id ?? "").trim();
        const qty = Number.isFinite(line.count) ? Number(line.count) : 0;
        if (!cardSourceId || qty <= 0) continue;
        deckCardRows.push({
          deck_id: deckId,
          card_source: "pokemon-tcg-data",
          card_source_id: cardSourceId,
          qty,
        });
      }
    }

    console.log(`[${fileName}] Upserting decks (${deckRows.length})`);
    counts.decksUpserted += await upsertBatches(supabase, "decks", deckRows, "id");
    if (deckAliasRows.length > 0) {
      console.log(`[${fileName}] Upserting deck_aliases (${deckAliasRows.length})`);
      await upsertBatches(supabase, "deck_aliases", deckAliasRows, "alias");
    }
    if (deckCardRows.length > 0) {
      console.log(`[${fileName}] Upserting deck_cards (${deckCardRows.length})`);
      counts.deckCardsUpserted += await upsertBatches(
        supabase,
        "deck_cards",
        deckCardRows,
        "deck_id,card_source,card_source_id"
      );
    }

    counts.deckFilesProcessed += 1;
    state.lastProcessedDeckFileIndex = deckFileIndex;
    saveState(state);
    console.log(`[${fileName}] Completed. State saved at deck index ${state.lastProcessedDeckFileIndex}`);
  }

  console.log("");
  console.log("Import complete.");
  console.log(`Card files processed: ${counts.cardFilesProcessed}`);
  console.log(`Deck files processed: ${counts.deckFilesProcessed}`);
  console.log(`Cards upserted: ${counts.cardsUpserted}`);
  console.log(`Printings upserted: ${counts.printingsUpserted}`);
  console.log(`Decks upserted: ${counts.decksUpserted}`);
  console.log(`Deck cards upserted: ${counts.deckCardsUpserted}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
