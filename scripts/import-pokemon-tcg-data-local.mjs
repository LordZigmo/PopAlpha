import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env.local");
const statePath = path.join(__dirname, "import-state.json");

const BATCH_SIZE = 250;

function loadEnvFile(filePath) {
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
  for (const batchRows of chunk(rows, BATCH_SIZE)) {
    const { error } = await supabase.from(table).upsert(batchRows, { onConflict });
    if (error) {
      throw new Error(`${table} upsert failed: ${error.message}`);
    }
    processed += batchRows.length;
  }
  return processed;
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

    counts.cardsUpserted += await upsertBatches(supabase, "canonical_cards", canonicalRows, "slug");

    const printingIdBySourceId = new Map();
    for (const batchRows of chunk(printingRows, BATCH_SIZE)) {
      const { data, error } = await supabase
        .from("card_printings")
        .upsert(batchRows, { onConflict: "source,source_id" })
        .select("id, source_id");
      if (error) {
        throw new Error(`card_printings upsert failed: ${error.message}`);
      }
      counts.printingsUpserted += batchRows.length;
      for (const row of data ?? []) {
        if (row?.source_id && row?.id) {
          printingIdBySourceId.set(row.source_id, row.id);
        }
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
      await upsertBatches(supabase, "printing_aliases", resolvedPrintingAliases, "alias");
    }

    if (cardAliasRows.length > 0) {
      await upsertBatches(supabase, "card_aliases", cardAliasRows, "alias,canonical_slug");
    }

    counts.cardFilesProcessed += 1;
    state.lastProcessedCardFileIndex = cardFileIndex;
    saveState(state);
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

    counts.decksUpserted += await upsertBatches(supabase, "decks", deckRows, "id");
    if (deckAliasRows.length > 0) {
      await upsertBatches(supabase, "deck_aliases", deckAliasRows, "alias");
    }
    if (deckCardRows.length > 0) {
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
