#!/usr/bin/env node
/**
 * JP listing-title gloss tool.
 *
 * Paste any Japanese Pokemon-card listing title; get annotated English
 * back. Designed for non-Japanese-readers to validate scraper matches
 * and understand listings without leaving the terminal.
 *
 * Two modes:
 *   1. Stdin / arg: gloss a single listing
 *   2. --file=<path>: gloss every line in a file
 *
 * Examples:
 *   node scripts/jp-gloss.mjs "sB018s [当時物] 旧裏面 ポケモンカード リザードン LV.76 第1弾"
 *   echo "title goes here" | node scripts/jp-gloss.mjs
 *   node scripts/jp-gloss.mjs --file=/tmp/yahoo-jp-validation/q1.json --json-listings
 *
 * Output annotations cover four buckets:
 *   ERA       (旧裏 = old-back era, etc.)
 *   EDITION   (1ED, 第1弾)
 *   GRADING   (PSA10, 鑑定品)
 *   POKEMON   (リザードン → Charizard)
 *   RARITY    (UR, レアホロ)
 *   PHRASE    (free shipping, BIN, etc.)
 *   EXCLUDE   (warns when title looks like a lot/sealed/accessory)
 *
 * What this tool does NOT do (yet):
 *   - Look up canonical_cards in the DB to suggest match candidates.
 *     That's the matcher's job (Day 2 PM); this tool is purely
 *     glossary-based to keep it fast and DB-free.
 */

import fs from "node:fs";
import { ALL_GLOSSARY_SORTED, HARD_EXCLUDE_TOKENS } from "../lib/jp/glossary.mjs";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const CATEGORY_COLORS = {
  era: ANSI.cyan,
  edition: ANSI.cyan,
  condition: ANSI.green,
  grading: ANSI.magenta,
  rarity: ANSI.yellow,
  pokemon: ANSI.bold + ANSI.blue,
  trainer_prefix: ANSI.bold + ANSI.blue,
  set: ANSI.bold + ANSI.blue,
  phrase: ANSI.dim,
  exclude: ANSI.red,
};

/**
 * Walk the title left-to-right, longest-match-first against the glossary.
 * Returns array of { start, end, jp, en, note, category } spans plus
 * unmatched residue.
 */
function glossTitle(title) {
  const cleaned = String(title ?? "").trim();
  const matches = [];
  const consumed = new Array(cleaned.length).fill(false);

  // ASCII-letter check used to suppress short-token false positives —
  // e.g., the rarity symbol "C" (= Common) shouldn't match the "C" inside
  // the Latin word "Charizard". Only the rarity-symbol use of these
  // letters is glossary-relevant; other uses are noise.
  const ASCII_LETTER = /[A-Za-z]/;
  // Single-letter ASCII glossary entries that should require word
  // boundaries (no ASCII letter immediately before or after).
  const ASCII_SINGLE_LETTERS = new Set(["C", "U", "R", "PR", "AR", "SR", "RR", "UR", "MUR", "RRR", "SAR"]);

  for (const entry of ALL_GLOSSARY_SORTED) {
    const requiresBoundary =
      entry.jp.length <= 3 && /^[A-Za-z]+$/.test(entry.jp) && ASCII_SINGLE_LETTERS.has(entry.jp);
    let idx = 0;
    while (true) {
      const found = cleaned.indexOf(entry.jp, idx);
      if (found < 0) break;

      // Boundary check for ASCII-letter rarity symbols
      if (requiresBoundary) {
        const prev = found > 0 ? cleaned[found - 1] : "";
        const next = cleaned[found + entry.jp.length] ?? "";
        if (ASCII_LETTER.test(prev) || ASCII_LETTER.test(next)) {
          idx = found + 1;
          continue;
        }
      }

      // Skip if any of these chars already consumed
      let overlapping = false;
      for (let i = found; i < found + entry.jp.length; i += 1) {
        if (consumed[i]) {
          overlapping = true;
          break;
        }
      }
      if (!overlapping) {
        matches.push({
          start: found,
          end: found + entry.jp.length,
          jp: entry.jp,
          en: entry.en,
          note: entry.note,
          category: entry.category,
        });
        for (let i = found; i < found + entry.jp.length; i += 1) consumed[i] = true;
      }
      idx = found + 1;
    }
  }

  // Detect hard-exclusions even when the term wasn't already hit by glossary.
  const excludeHits = [];
  for (const token of HARD_EXCLUDE_TOKENS) {
    if (cleaned.includes(token)) excludeHits.push(token);
  }

  // Detect grade patterns via regex (PSA10, BGS9.5, CGC10, ARS9, TAG9.5)
  const gradePattern = /\b(PSA|BGS|CGC|ARS|TAG)\s*([0-9]+(?:\.[0-9])?)\b/gi;
  const gradeHits = [];
  let m;
  while ((m = gradePattern.exec(cleaned)) !== null) {
    gradeHits.push({ company: m[1].toUpperCase(), grade: m[2] });
  }

  // Detect card-number-like tokens (e.g., "4/102", "017/090", "001/028")
  const cardNumberPattern = /\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g;
  const cardNumbers = [];
  while ((m = cardNumberPattern.exec(cleaned)) !== null) {
    cardNumbers.push({ num: m[1], denom: m[2] });
  }

  // Detect set codes (ASCII upper+digit, e.g., "S8a", "SV1a", "Pt4")
  const setCodePattern = /\b([A-Z]{1,3}[0-9]+[a-z]?)\b/g;
  const setCodes = [];
  while ((m = setCodePattern.exec(cleaned)) !== null) {
    if (m[1].length >= 2 && m[1].length <= 5) setCodes.push(m[1]);
  }

  matches.sort((a, b) => a.start - b.start);
  return { cleaned, matches, excludeHits, gradeHits, cardNumbers, setCodes, consumed };
}

function renderColor(text, color) {
  return process.stdout.isTTY ? `${color}${text}${ANSI.reset}` : text;
}

function renderGloss(title) {
  const result = glossTitle(title);
  const lines = [];

  lines.push(renderColor("ORIGINAL: ", ANSI.bold) + result.cleaned);
  lines.push("");

  // Inline annotation: rebuild title with each glossed term followed by its EN
  let annotated = "";
  let cursor = 0;
  for (const m of result.matches) {
    annotated += result.cleaned.slice(cursor, m.start);
    const color = CATEGORY_COLORS[m.category] ?? ANSI.reset;
    annotated += renderColor(m.jp, color) + renderColor(`{${m.en}}`, ANSI.dim);
    cursor = m.end;
  }
  annotated += result.cleaned.slice(cursor);
  lines.push(renderColor("ANNOTATED: ", ANSI.bold) + annotated);
  lines.push("");

  // Categorized findings
  const byCat = {};
  for (const m of result.matches) {
    if (!byCat[m.category]) byCat[m.category] = [];
    byCat[m.category].push(m);
  }
  const orderedCats = ["pokemon", "trainer_prefix", "set", "era", "edition", "rarity", "grading", "condition", "phrase"];
  for (const cat of orderedCats) {
    if (!byCat[cat] || byCat[cat].length === 0) continue;
    const color = CATEGORY_COLORS[cat] ?? ANSI.reset;
    lines.push(renderColor(`  ${cat.toUpperCase()}:`, color));
    for (const m of byCat[cat]) {
      const note = m.note ? ` — ${m.note}` : "";
      lines.push(`    ${m.jp} → ${m.en}${renderColor(note, ANSI.dim)}`);
    }
  }

  // Grade hits (regex-based, separate from glossary)
  if (result.gradeHits.length > 0) {
    lines.push(renderColor(`  GRADE (regex):`, CATEGORY_COLORS.grading));
    for (const g of result.gradeHits) {
      lines.push(`    ${g.company} ${g.grade}`);
    }
  }

  // Card number hits
  if (result.cardNumbers.length > 0) {
    lines.push(renderColor(`  CARD-NUMBER:`, ANSI.cyan));
    for (const n of result.cardNumbers) {
      lines.push(`    ${n.num}/${n.denom}`);
    }
  }

  // Set codes
  if (result.setCodes.length > 0) {
    lines.push(renderColor(`  SET-CODE (heuristic):`, ANSI.cyan));
    lines.push(`    ${result.setCodes.join(", ")}`);
  }

  // Exclusion warnings
  if (result.excludeHits.length > 0) {
    lines.push("");
    lines.push(renderColor(`  ⚠ EXCLUDE WARNING (likely not a single card):`, CATEGORY_COLORS.exclude));
    lines.push(`    matched tokens: ${result.excludeHits.join(", ")}`);
  }

  return lines.join("\n");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { texts: [], file: null, jsonListings: false, raw: false };
  for (const arg of args) {
    if (arg.startsWith("--file=")) opts.file = arg.slice("--file=".length);
    else if (arg === "--json-listings") opts.jsonListings = true;
    else if (arg === "--raw") opts.raw = true;
    else if (!arg.startsWith("--")) opts.texts.push(arg);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  // Source 1: --file
  if (opts.file) {
    const raw = fs.readFileSync(opts.file, "utf-8");
    let titles = [];
    if (opts.jsonListings) {
      // Expects scraper output JSON: { listings: [{ title, ... }] }
      const data = JSON.parse(raw);
      titles = (data.listings ?? []).map((l) => l.title).filter(Boolean);
    } else {
      titles = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    }
    for (const [i, t] of titles.entries()) {
      console.log(renderColor(`\n=== ${i + 1}/${titles.length} ===`, ANSI.bold));
      console.log(renderGloss(t));
    }
    return;
  }

  // Source 2: positional args
  if (opts.texts.length > 0) {
    for (const t of opts.texts) {
      console.log(renderGloss(t));
      console.log();
    }
    return;
  }

  // Source 3: stdin
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    if (text) {
      console.log(renderGloss(text));
      return;
    }
  }

  console.error("Usage:");
  console.error("  node scripts/jp-gloss.mjs \"<japanese title>\"");
  console.error("  echo \"<japanese title>\" | node scripts/jp-gloss.mjs");
  console.error("  node scripts/jp-gloss.mjs --file=<path>          # one title per line");
  console.error("  node scripts/jp-gloss.mjs --file=<path> --json-listings  # scraper JSON output");
  process.exit(1);
}

main().catch((err) => {
  console.error("[jp-gloss] FAILED:", err);
  process.exit(1);
});
