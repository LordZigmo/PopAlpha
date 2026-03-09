#!/usr/bin/env node

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildCanonicalSearchDoc, normalizeSearchText } from "../lib/search/normalize.mjs";

const SCRYDEX_BASE_URL = "https://api.scrydex.com/pokemon/v1";
const DEFAULT_PAGE_SIZE = 100;
const UPSERT_BATCH_SIZE = 100;
const PRINTING_ALIAS_BATCH_SIZE = 400;
const MAX_RETRY_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 1200;
const REQUEST_TIMEOUT_MS = 30_000;

dotenv.config({ path: ".env.local" });

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}

function parseArgs(argv) {
  const args = new Set(argv);
  const getValue = (prefix) => {
    const match = [...args].find((arg) => arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
  };

  return {
    dryRun: args.has("--dry-run"),
    onlyMissing: args.has("--only-missing"),
    setCodes: (getValue("--set-codes=") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    limit: (() => {
      const raw = getValue("--limit=");
      if (!raw) return null;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })(),
  };
}

function parseYearFromReleaseDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function slugify(input) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 200);
}

function parseCardNumber(rawNumber) {
  const trimmed = String(rawNumber ?? "").trim();
  const slashMatch = trimmed.match(/^#?\s*(\d+)\s*\/\s*\d+/i);
  if (slashMatch) return slashMatch[1];
  const numberMatch = trimmed.match(/^#?\s*(\d+)/);
  return numberMatch ? numberMatch[1] : trimmed;
}

function extractSubject(name) {
  const prefixes = [
    /^team rocket's\s+/i,
    /^brock's\s+/i,
    /^misty's\s+/i,
    /^erika's\s+/i,
    /^giovanni's\s+/i,
    /^dark\s+/i,
    /^light\s+/i,
  ];

  let working = String(name ?? "").trim();
  for (const prefix of prefixes) working = working.replace(prefix, "");
  working = working
    .replace(/\s+(ex|gx|vmax|vstar|v|lv\.x)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return working || String(name ?? "").trim();
}

function variantNameToFinish(variantName) {
  const lower = String(variantName ?? "").toLowerCase().replace(/-/g, "");
  if (lower.includes("1stedition") || lower.includes("firstedition")) {
    return { finish: "HOLO", edition: "FIRST_EDITION" };
  }
  if (lower === "normal" || lower === "nonholo") {
    return { finish: "NON_HOLO", edition: "UNLIMITED" };
  }
  if (lower === "holofoil" || lower === "holo") {
    return { finish: "HOLO", edition: "UNLIMITED" };
  }
  if (lower.includes("reverse") || lower === "reverseholofoil") {
    return { finish: "REVERSE_HOLO", edition: "UNLIMITED" };
  }
  if (lower === "unknown") {
    return { finish: "UNKNOWN", edition: "UNKNOWN" };
  }
  return { finish: "ALT_HOLO", edition: "UNKNOWN" };
}

function buildAliases(cardName, setName, parsedNumber, rawNumber) {
  const raw = [
    `${cardName} ${parsedNumber}`,
    `${cardName} ${rawNumber}`,
    setName ? `${setName} ${cardName} ${parsedNumber}` : "",
    setName ? `${setName} ${parsedNumber}` : "",
  ];
  return [...new Set(raw.map((entry) => normalizeSearchText(entry)).filter(Boolean))];
}

function toPreparedCard(card, setYearMap) {
  const rawNumber = (card.number ?? card.printed_number ?? "").trim();
  const parsedNumber = parseCardNumber(rawNumber);
  const setName = card.expansion?.name?.trim() ?? null;
  const setCode = card.expansion?.id?.trim() ?? null;
  const year =
    setYearMap.get(card.expansion?.id ?? "") ??
    parseYearFromReleaseDate(card.expansion?.release_date ?? card.expansion?.releaseDate) ??
    null;
  const images = card.images ?? [];
  const firstImage = images[0];
  const imageUrl =
    firstImage && (firstImage.large ?? firstImage.medium ?? firstImage.small)
      ? (firstImage.large ?? firstImage.medium ?? firstImage.small) ?? null
      : null;
  const subject = extractSubject(card.name);
  const canonicalSlug =
    slugify(`${setName ?? "unknown-set"}-${parsedNumber}-${card.name}`) || slugify(card.id);

  const variants = card.variants?.length ? card.variants : [{ name: "unknown" }];
  const printings = variants.map((variant) => {
    const { finish, edition } = variantNameToFinish(variant.name);
    const variantKey = String(variant.name ?? "unknown");
    const sourceId = `${card.id}:${finish}:${variantKey}`;
    const finishDetail =
      edition !== "UNLIMITED"
        ? variantKey
        : rawNumber !== parsedNumber
          ? `No. ${rawNumber}`
          : variantKey;
    const variantImage = variant.images?.[0];
    const variantImageUrl =
      variantImage && (variantImage.large ?? variantImage.medium ?? variantImage.small)
        ? (variantImage.large ?? variantImage.medium ?? variantImage.small) ?? null
        : null;

    return {
      sourceId,
      setName,
      setCode,
      year,
      cardNumber: parsedNumber,
      rawNumber,
      language: "EN",
      finish,
      finishDetail,
      edition,
      rarity: card.rarity ?? null,
      imageUrl: imageUrl ?? variantImageUrl,
      aliases: buildAliases(card.name, setName, parsedNumber, rawNumber),
    };
  });

  const searchDoc = buildCanonicalSearchDoc({
    canonical_name: card.name,
    subject,
    set_name: setName,
    card_number: parsedNumber || null,
    year,
  });

  return {
    canonical: {
      slug: canonicalSlug,
      canonical_name: card.name,
      subject,
      set_name: setName,
      year,
      card_number: parsedNumber || null,
      language: "EN",
      variant: "SCRYDEX",
      primary_image_url: imageUrl,
      search_doc: searchDoc,
      search_doc_norm: normalizeSearchText(searchDoc),
    },
    printings,
    canonicalAliases: [
      ...new Set(
        [
          normalizeSearchText(card.name),
          setName ? normalizeSearchText(`${setName} ${card.name}`) : "",
          parsedNumber ? normalizeSearchText(`${card.name} ${parsedNumber}`) : "",
        ].filter(Boolean),
      ),
    ],
  };
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : 0;
}

function isRetryableHttpStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504, 522, 524].includes(status);
}

function isRetryableNetworkError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("fetch failed")
    || message.includes("network")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("socket")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("eai_again")
  );
}

async function fetchScrydexJson(path, params, credentials) {
  const url = `${SCRYDEX_BASE_URL}${path}?${params.toString()}`;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "X-Api-Key": credentials.apiKey,
          "X-Team-ID": credentials.teamId,
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (response.ok) {
        clearTimeout(timeoutId);
        return response.json();
      }

      const body = (await response.text()).slice(0, 400);
      lastError = `Scrydex API error ${response.status}: ${body}`;
      clearTimeout(timeoutId);

      if (attempt >= MAX_RETRY_ATTEMPTS || !isRetryableHttpStatus(response.status)) break;

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await sleep(retryAfterMs ?? (RETRY_BACKOFF_MS * attempt));
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= MAX_RETRY_ATTEMPTS || !isRetryableNetworkError(error)) break;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  throw new Error(lastError ?? "Scrydex request failed");
}

async function fetchAllExpansions(credentials) {
  const expansions = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(DEFAULT_PAGE_SIZE),
    });
    const payload = await fetchScrydexJson("/en/expansions", params, credentials);
    const rows = payload.data ?? [];
    expansions.push(...rows);
    if (rows.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
    await sleep(200);
  }
  return expansions;
}

async function loadExistingPrintingSetCodes(supabase) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("set_code")
      .eq("language", "EN")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`card_printings(set_code): ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }

  return new Set(rows.map((row) => String(row.set_code ?? "").trim()).filter(Boolean));
}

async function loadExistingScrydexProviderMapCodes(supabase) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("provider_set_map")
      .select("canonical_set_code")
      .eq("provider", "SCRYDEX")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`provider_set_map(SCRYDEX): ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }

  return new Set(rows.map((row) => String(row.canonical_set_code ?? "").trim()).filter(Boolean));
}

async function upsertBatches(supabase, table, rows, onConflict) {
  let written = 0;
  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`${table}(upsert): ${error.message}`);
    written += batch.length;
  }
  return written;
}

async function findExistingPrintingRow(supabase, row) {
  let query = supabase
    .from("card_printings")
    .select("id, source_id")
    .eq("card_number", row.card_number)
    .eq("language", row.language)
    .eq("finish", row.finish)
    .eq("edition", row.edition);

  query = row.set_code ? query.eq("set_code", row.set_code) : query.is("set_code", null);
  query = row.stamp ? query.eq("stamp", row.stamp) : query.is("stamp", null);
  query = row.finish_detail
    ? query.eq("finish_detail", row.finish_detail)
    : query.is("finish_detail", null);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(`card_printings(find existing): ${error.message}`);
  return data;
}

function isUniquePrintingConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("card_printings_unique_printing_idx");
}

async function syncSinglePrintingRow(supabase, row) {
  const { data: existingBySourceId, error: selectError } = await supabase
    .from("card_printings")
    .select("id, source_id")
    .eq("source", "scrydex")
    .eq("source_id", row.source_id)
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error(`card_printings(select by source_id): ${selectError.message}`);

  if (existingBySourceId?.id) {
    const { error: updateError } = await supabase
      .from("card_printings")
      .update(row)
      .eq("id", existingBySourceId.id);
    if (updateError) throw new Error(`card_printings(update): ${updateError.message}`);
    return { id: existingBySourceId.id, source_id: row.source_id };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("card_printings")
    .insert(row)
    .select("id, source_id")
    .single();
  if (!insertError) return inserted;
  if (!isUniquePrintingConflict(insertError)) {
    throw new Error(`card_printings(insert): ${insertError.message}`);
  }

  const collidedRow = await findExistingPrintingRow(supabase, row);
  if (!collidedRow?.id) {
    throw new Error(`card_printings(insert after conflict): ${insertError.message}`);
  }

  const { error: updateError } = await supabase
    .from("card_printings")
    .update(row)
    .eq("id", collidedRow.id);
  if (updateError) throw new Error(`card_printings(update after conflict): ${updateError.message}`);
  return { id: collidedRow.id, source_id: row.source_id };
}

async function syncPrintingRows(supabase, rows) {
  const sourceIdToPrintingId = new Map();
  const existingMap = new Map();

  for (const batch of chunk(rows.map((row) => row.source_id), 1000)) {
    const { data, error } = await supabase
      .from("card_printings")
      .select("id, source_id")
      .eq("source", "scrydex")
      .in("source_id", batch);
    if (error) throw new Error(`card_printings(batch select): ${error.message}`);
    for (const row of data ?? []) existingMap.set(row.source_id, row.id);
  }

  const toUpdate = rows.filter((row) => existingMap.has(row.source_id));

  for (const row of toUpdate) {
    const id = existingMap.get(row.source_id);
    const { error } = await supabase.from("card_printings").update(row).eq("id", id);
    if (error) throw new Error(`card_printings(update existing): ${error.message}`);
    sourceIdToPrintingId.set(row.source_id, id);
  }

  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    const insertBatch = batch.filter((row) => !existingMap.has(row.source_id));
    if (insertBatch.length === 0) continue;

    const { data, error } = await supabase
      .from("card_printings")
      .insert(insertBatch)
      .select("id, source_id");

    if (!error && data) {
      for (const row of data) sourceIdToPrintingId.set(row.source_id, row.id);
      continue;
    }

    for (const row of insertBatch) {
      const synced = await syncSinglePrintingRow(supabase, row);
      if (synced?.source_id && synced?.id) {
        sourceIdToPrintingId.set(synced.source_id, synced.id);
      }
    }
  }

  return sourceIdToPrintingId;
}

async function importExpansionCards({ supabase, credentials, expansion, setYearMap, dryRun }) {
  let page = 1;
  let cardsFetched = 0;
  let cardsUpserted = 0;
  let printingRowsUpserted = 0;

  while (true) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(DEFAULT_PAGE_SIZE),
      include: "prices",
    });
    const payload = await fetchScrydexJson(`/en/expansions/${encodeURIComponent(expansion.id)}/cards`, params, credentials);
    const cards = payload.data ?? [];
    if (cards.length === 0) break;

    const preparedCards = cards.map((card) => toPreparedCard(card, setYearMap));
    cardsFetched += cards.length;

    if (!dryRun) {
      const canonicalRows = preparedCards.map((row) => row.canonical);
      cardsUpserted += await upsertBatches(supabase, "canonical_cards", canonicalRows, "slug");

      const canonicalAliasRows = preparedCards.flatMap((row) =>
        row.canonicalAliases.map((alias) => ({
          alias,
          alias_norm: normalizeSearchText(alias),
          canonical_slug: row.canonical.slug,
        })),
      );
      if (canonicalAliasRows.length > 0) {
        await upsertBatches(supabase, "card_aliases", canonicalAliasRows, "alias,canonical_slug");
      }

      const printingRows = preparedCards.flatMap((row) =>
        row.printings.map((printing) => ({
          canonical_slug: row.canonical.slug,
          set_name: printing.setName,
          set_code: printing.setCode,
          year: printing.year,
          card_number: printing.cardNumber,
          language: printing.language,
          finish: printing.finish,
          finish_detail: printing.finishDetail,
          edition: printing.edition,
          stamp: null,
          rarity: printing.rarity,
          image_url: printing.imageUrl,
          source: "scrydex",
          source_id: printing.sourceId,
          updated_at: new Date().toISOString(),
        })),
      );
      const printingIdBySourceId = await syncPrintingRows(supabase, printingRows);
      printingRowsUpserted += printingRows.length;

      const printingAliasRows = [];
      const seenAliases = new Set();
      for (const row of preparedCards) {
        for (const printing of row.printings) {
          const printingId = printingIdBySourceId.get(printing.sourceId);
          if (!printingId) continue;
          for (const alias of printing.aliases) {
            if (!alias || seenAliases.has(alias)) continue;
            seenAliases.add(alias);
            printingAliasRows.push({ alias, printing_id: printingId });
          }
        }
      }

      for (const batch of chunk(printingAliasRows, PRINTING_ALIAS_BATCH_SIZE)) {
        const { error } = await supabase
          .from("printing_aliases")
          .upsert(batch, { onConflict: "alias" });
        if (error) throw new Error(`printing_aliases(upsert): ${error.message}`);
      }
    } else {
      cardsUpserted += preparedCards.length;
      printingRowsUpserted += preparedCards.reduce((sum, row) => sum + row.printings.length, 0);
    }

    if (cards.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
    await sleep(200);
  }

  return {
    setCode: expansion.id,
    setName: expansion.name,
    cardsFetched,
    cardsUpserted,
    printingRowsUpserted,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = {
    apiKey: requireEnv("SCRYDEX_API_KEY"),
    teamId: requireEnv("SCRYDEX_TEAM_ID"),
  };
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  console.log("[import-scrydex-direct] Loading expansions...");
  const expansions = await fetchAllExpansions(credentials);
  const setYearMap = new Map(
    expansions.map((row) => [
      row.id,
      parseYearFromReleaseDate(row.release_date ?? row.releaseDate) ?? null,
    ]),
  );

  const existingSetCodes = await loadExistingPrintingSetCodes(supabase);
  const existingScrydexMapCodes = await loadExistingScrydexProviderMapCodes(supabase);

  let targets = expansions.filter((row) => row.id && row.name);
  if (args.onlyMissing) {
    targets = targets.filter((row) => !existingSetCodes.has(String(row.id).trim()));
  }
  if (args.setCodes.length > 0) {
    const wanted = new Set(args.setCodes);
    targets = targets.filter((row) => wanted.has(String(row.id).trim()));
  }
  if (args.limit != null) {
    targets = targets.slice(0, args.limit);
  }

  console.log(JSON.stringify({
    totalExpansions: expansions.length,
    existingPrintingSetCodes: existingSetCodes.size,
    targetExpansions: targets.length,
    dryRun: args.dryRun,
    onlyMissing: args.onlyMissing,
  }, null, 2));

  if (targets.length === 0) {
    console.log("[import-scrydex-direct] Nothing to do.");
    return;
  }

  if (!args.dryRun) {
    const missingMapRows = targets
      .filter((row) => !existingScrydexMapCodes.has(String(row.id).trim()))
      .map((row) => ({
        provider: "SCRYDEX",
        canonical_set_code: row.id,
        canonical_set_name: row.name,
        provider_set_id: row.id,
        confidence: 1,
      }));
    if (missingMapRows.length > 0) {
      await upsertBatches(supabase, "provider_set_map", missingMapRows, "provider,canonical_set_code");
      console.log(`[import-scrydex-direct] Seeded ${missingMapRows.length} SCRYDEX provider_set_map row(s).`);
    }
  }

  let totalCardsFetched = 0;
  let totalCardsUpserted = 0;
  let totalPrintingsUpserted = 0;

  for (const [index, expansion] of targets.entries()) {
    console.log(`[import-scrydex-direct] ${index + 1}/${targets.length} ${expansion.id} ${expansion.name}`);
    const result = await importExpansionCards({
      supabase,
      credentials,
      expansion,
      setYearMap,
      dryRun: args.dryRun,
    });
    totalCardsFetched += result.cardsFetched;
    totalCardsUpserted += result.cardsUpserted;
    totalPrintingsUpserted += result.printingRowsUpserted;
    console.log(JSON.stringify(result));
    await sleep(250);
  }

  console.log(JSON.stringify({
    ok: true,
    expansionsProcessed: targets.length,
    totalCardsFetched,
    totalCardsUpserted,
    totalPrintingsUpserted,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
