#!/usr/bin/env node
// Repair card_printings / canonical_cards rows whose stored image URL
// 404s on pokemontcg.io by swapping in Scrydex URLs and mirroring the
// images into our own Storage bucket (so card detail views stop hitting
// Scrydex for every render).
//
// Usage:
//   node scripts/repair-broken-card-images.mjs --dry-run
//   node scripts/repair-broken-card-images.mjs
//
// Scope: rows where (image_url IS NULL) OR (mirrored_image_url IS NULL
// AND image_mirror_last_error LIKE '%404%'). We keep it narrow on
// purpose — don't touch rows whose mirror is just pending.

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

dotenv.config({ path: ".env.local" });

const SCRYDEX_BASE_URL = "https://api.scrydex.com/pokemon/v1";
const IMAGE_BUCKET = "card-images";
const THUMB_WIDTH = 256;
const THUMB_QUALITY = 82;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const DRY_RUN = process.argv.includes("--dry-run");

// Seed rows don't carry Scrydex-compatible set_code/card_number, so map
// them explicitly. Every other affected row uses its own set_code +
// card_number, which already match Scrydex's expansion id + number.
const SEED_SLUG_TO_SCRYDEX = {
  "1999_base_set_pikachu_58_102_1st_edition_yellow_cheeks_en": { lang: "en", expansion: "base1", number: "58" },
  "1999_base_set_pikachu_58_102_unlimited_yellow_cheeks_en": { lang: "en", expansion: "base1", number: "58" },
  "2016_xy_evolutions_pikachu_35_108_en": { lang: "en", expansion: "xy12", number: "35" },
  "2023_pokemon_card_151_mew_ex_205_165_jp_bubble_mew": { lang: "ja", expansion: "sv2a_ja", number: "205" },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url, timeoutMs, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scrydexFetchJson(path, scrydex) {
  const url = `${SCRYDEX_BASE_URL}${path}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, {
      headers: { "X-Api-Key": scrydex.apiKey, "X-Team-ID": scrydex.teamId },
      cache: "no-store",
    });
    if (res.ok) return res.json();
    const body = (await res.text()).slice(0, 200);
    if (attempt === 4 || ![429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`Scrydex ${res.status} for ${url}: ${body}`);
    }
    await sleep(800 * attempt);
  }
  throw new Error("unreachable");
}

async function loadAllExpansionCards(lang, expansionId, scrydex) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await scrydexFetchJson(
      `/${lang}/expansions/${encodeURIComponent(expansionId)}/cards?page=${page}&page_size=100`,
      scrydex,
    );
    const rows = j.data ?? [];
    out.push(...rows);
    if (rows.length < 100) break;
    await sleep(150);
  }
  return out;
}

function safePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function printingStorageKey(source, sourceId, fallbackId) {
  const tail = sourceId ? safePathSegment(sourceId) : safePathSegment(fallbackId);
  return `printings/${safePathSegment(source)}/${tail}`;
}

function canonicalStorageKey(slug) {
  return `canonical/${safePathSegment(slug)}`;
}

function extensionForContentType(contentType) {
  const normalized = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  return "bin";
}

async function mirrorImage(sourceUrl, storageKey, supabase) {
  const res = await fetchWithTimeout(sourceUrl, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`fetch ${sourceUrl} failed: ${res.status} ${res.statusText}`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const fullBuf = Buffer.from(await res.arrayBuffer());

  const thumbBuf = await sharp(fullBuf)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  const fullExt = extensionForContentType(contentType);
  const fullKey = `${storageKey}/full.${fullExt}`;
  const thumbKey = `${storageKey}/thumb.webp`;

  const [fullUp, thumbUp] = await Promise.all([
    supabase.storage.from(IMAGE_BUCKET).upload(fullKey, fullBuf, {
      upsert: true,
      contentType,
      cacheControl: "31536000, immutable",
    }),
    supabase.storage.from(IMAGE_BUCKET).upload(thumbKey, thumbBuf, {
      upsert: true,
      contentType: "image/webp",
      cacheControl: "31536000, immutable",
    }),
  ]);
  if (fullUp.error) throw new Error(`upload full failed: ${fullUp.error.message}`);
  if (thumbUp.error) throw new Error(`upload thumb failed: ${thumbUp.error.message}`);

  const fullUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(fullKey).data.publicUrl;
  const thumbUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(thumbKey).data.publicUrl;
  return { fullUrl, thumbUrl };
}

function pickScrydexUrl(card) {
  const imgs = card?.images ?? [];
  const first = imgs[0];
  return first?.large ?? first?.medium ?? first?.small ?? null;
}

async function processRows(rows, concurrency, worker) {
  let index = 0;
  const results = new Array(rows.length);
  async function runner() {
    while (true) {
      const i = index++;
      if (i >= rows.length) return;
      try {
        results[i] = { ok: true, value: await worker(rows[i]) };
      } catch (err) {
        results[i] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, runner));
  return results;
}

async function main() {
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const scrydex = { apiKey: requireEnv("SCRYDEX_API_KEY"), teamId: requireEnv("SCRYDEX_TEAM_ID") };

  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);

  // 1. Load affected printings.
  const { data: printings, error: pErr } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, set_code, card_number, source, source_id, language, image_url, mirrored_image_url, image_mirror_attempts")
    .or("image_url.is.null,mirrored_image_url.is.null");
  if (pErr) throw new Error(`select printings: ${pErr.message}`);

  console.log(`Loaded ${printings.length} candidate printing rows.`);

  // 2. Load matching canonical rows.
  const slugs = [...new Set(printings.map((p) => p.canonical_slug).filter(Boolean))];
  const { data: canonicals, error: cErr } = await supabase
    .from("canonical_cards")
    .select("slug, primary_image_url, mirrored_primary_image_url")
    .in("slug", slugs);
  if (cErr) throw new Error(`select canonicals: ${cErr.message}`);
  console.log(`Loaded ${canonicals.length} matching canonical rows.`);

  // 3. Resolve (lang, expansion, number) for every printing row.
  const resolutions = printings.map((row) => {
    const seed = SEED_SLUG_TO_SCRYDEX[row.canonical_slug];
    if (seed) return { row, lang: seed.lang, expansion: seed.expansion, number: seed.number };
    // pokemon-tcg-data rows: set_code == Scrydex expansion id, card_number matches directly.
    return { row, lang: "en", expansion: row.set_code, number: row.card_number };
  });

  const unresolvable = resolutions.filter((r) => !r.expansion || !r.number);
  if (unresolvable.length) {
    console.warn(`Skipping ${unresolvable.length} rows without expansion/number:`);
    for (const u of unresolvable) console.warn(`  - ${u.row.id} ${u.row.canonical_slug}`);
  }

  // 4. Fetch each (lang, expansion) from Scrydex exactly once.
  const expansionKeys = [...new Set(resolutions.filter((r) => r.expansion).map((r) => `${r.lang}:${r.expansion}`))];
  const expansionCache = new Map(); // key → Map<number, card>
  for (const key of expansionKeys) {
    const [lang, expansion] = key.split(":");
    console.log(`  Fetching Scrydex ${lang}/${expansion}…`);
    const cards = await loadAllExpansionCards(lang, expansion, scrydex);
    const byNumber = new Map();
    for (const c of cards) byNumber.set(String(c.number), c);
    expansionCache.set(key, byNumber);
    console.log(`    → ${cards.length} cards`);
  }

  // 5. Build work items.
  const printingWork = [];
  const missing = [];
  for (const { row, lang, expansion, number } of resolutions) {
    if (!expansion || !number) continue;
    const byNumber = expansionCache.get(`${lang}:${expansion}`);
    const card = byNumber?.get(String(number));
    const scrydexUrl = pickScrydexUrl(card);
    if (!scrydexUrl) {
      missing.push({ id: row.id, slug: row.canonical_slug, reason: "no Scrydex image" });
      continue;
    }
    printingWork.push({ row, scrydexUrl });
  }

  const canonicalWork = [];
  for (const cc of canonicals) {
    const seed = SEED_SLUG_TO_SCRYDEX[cc.slug];
    let lang, expansion, number;
    if (seed) {
      ({ lang, expansion, number } = seed);
    } else {
      // Derive from any printing with this slug (they all share set_code/card_number).
      const sibling = printings.find((p) => p.canonical_slug === cc.slug && p.set_code && p.card_number);
      if (!sibling) {
        missing.push({ slug: cc.slug, reason: "no sibling printing to derive expansion" });
        continue;
      }
      lang = "en";
      expansion = sibling.set_code;
      number = sibling.card_number;
    }
    const card = expansionCache.get(`${lang}:${expansion}`)?.get(String(number));
    const scrydexUrl = pickScrydexUrl(card);
    if (!scrydexUrl) {
      missing.push({ slug: cc.slug, reason: "no Scrydex image for canonical" });
      continue;
    }
    canonicalWork.push({ canonical: cc, scrydexUrl });
  }

  console.log(`\nWork plan:`);
  console.log(`  Printings to repair: ${printingWork.length}`);
  console.log(`  Canonicals to repair: ${canonicalWork.length}`);
  if (missing.length) {
    console.log(`  Skipped ${missing.length} (no Scrydex match):`);
    for (const m of missing) console.log(`    - ${m.id ?? m.slug}: ${m.reason}`);
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — sampling first 3 of each:");
    for (const w of printingWork.slice(0, 3)) {
      console.log(`  printing ${w.row.canonical_slug} ${w.row.card_number} → ${w.scrydexUrl}`);
    }
    for (const w of canonicalWork.slice(0, 3)) {
      console.log(`  canonical ${w.canonical.slug} → ${w.scrydexUrl}`);
    }
    return;
  }

  // 6. Execute printings.
  console.log(`\nMirroring ${printingWork.length} printings…`);
  const pResults = await processRows(printingWork, CONCURRENCY, async (w) => {
    const row = w.row;
    const key = printingStorageKey(row.source ?? "scrydex", row.source_id, row.id);
    const { fullUrl, thumbUrl } = await mirrorImage(w.scrydexUrl, key, supabase);
    const { error } = await supabase
      .from("card_printings")
      .update({
        image_url: w.scrydexUrl,
        mirrored_image_url: fullUrl,
        mirrored_thumb_url: thumbUrl,
        image_mirrored_at: new Date().toISOString(),
        image_mirror_attempts: 0,
        image_mirror_last_error: null,
      })
      .eq("id", row.id);
    if (error) throw new Error(`update card_printings: ${error.message}`);
    return row.id;
  });
  const pOk = pResults.filter((r) => r?.ok).length;
  const pFail = pResults.length - pOk;
  console.log(`  Printings done: ${pOk} ok, ${pFail} failed`);
  for (let i = 0; i < pResults.length; i++) {
    const r = pResults[i];
    if (!r?.ok) console.error(`    FAIL ${printingWork[i].row.id}: ${r?.error}`);
  }

  // 7. Execute canonicals.
  console.log(`\nMirroring ${canonicalWork.length} canonicals…`);
  const cResults = await processRows(canonicalWork, CONCURRENCY, async (w) => {
    const slug = w.canonical.slug;
    const key = canonicalStorageKey(slug);
    const { fullUrl, thumbUrl } = await mirrorImage(w.scrydexUrl, key, supabase);
    const { error } = await supabase
      .from("canonical_cards")
      .update({
        primary_image_url: w.scrydexUrl,
        mirrored_primary_image_url: fullUrl,
        mirrored_primary_thumb_url: thumbUrl,
        image_mirrored_at: new Date().toISOString(),
        image_mirror_attempts: 0,
        image_mirror_last_error: null,
      })
      .eq("slug", slug);
    if (error) throw new Error(`update canonical_cards: ${error.message}`);
    return slug;
  });
  const cOk = cResults.filter((r) => r?.ok).length;
  const cFail = cResults.length - cOk;
  console.log(`  Canonicals done: ${cOk} ok, ${cFail} failed`);
  for (let i = 0; i < cResults.length; i++) {
    const r = cResults[i];
    if (!r?.ok) console.error(`    FAIL ${canonicalWork[i].canonical.slug}: ${r?.error}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
