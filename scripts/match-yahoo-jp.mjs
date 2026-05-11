#!/usr/bin/env node
/**
 * End-to-end JP matcher CLI.
 *
 * Takes a canonical_slug (or set+number+name), looks it up in the DB,
 * builds a precision Yahoo! query via lib/jp/matcher, runs the scraper,
 * scores + filters + grade-splits the results, and prints a human-
 * readable confidence-ranked report.
 *
 * Usage:
 *   node scripts/match-yahoo-jp.mjs --slug=<canonical-slug>
 *   node scripts/match-yahoo-jp.mjs --slugs=<slug1>,<slug2>,...
 *   node scripts/match-yahoo-jp.mjs --slug=expansion-pack-6-charizard-jp
 *   node scripts/match-yahoo-jp.mjs --slug=...slug... --json
 *   node scripts/match-yahoo-jp.mjs --random-jp=10                # 10 random JP cards
 *   node scripts/match-yahoo-jp.mjs --set-code=neo1_ja --limit=5  # 5 from a specific set
 *
 * Output for each card:
 *   - canonical: slug, EN name, EN set, card_number, year
 *   - JP query constructed
 *   - input listings (from scraper)
 *   - excluded (lots/sealed/wrong-category)
 *   - accepted by tier (HIGH/MEDIUM/LOW)
 *   - price observations grouped by grade (RAW, PSA10, CGC10, etc.)
 *   - warnings
 *
 * Performance: each card takes ~2-5s (1 scraper page + scoring).
 * Don't run on the full 20k JP catalog this way — that's the Day 4
 * pipeline orchestrator's job.
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { scrapeYahooJp } from "./scrape-yahoo-jp.mjs";
import { buildPrecisionQuery, selectMatched } from "../lib/jp/matcher.mjs";

dotenv.config({ path: ".env.local" });

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};
const c = (s, color) => (process.stdout.isTTY ? `${color}${s}${ANSI.reset}` : s);

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    slugs: [],
    randomJp: 0,
    setCode: null,
    limit: 1,
    pages: 1,
    minScore: 0.50,
    json: false,
  };
  for (const arg of args) {
    if (arg.startsWith("--slug=")) opts.slugs.push(arg.slice("--slug=".length));
    else if (arg.startsWith("--slugs=")) opts.slugs.push(...arg.slice("--slugs=".length).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg.startsWith("--random-jp=")) opts.randomJp = Math.max(1, Number.parseInt(arg.slice("--random-jp=".length), 10) || 0);
    else if (arg.startsWith("--set-code=")) opts.setCode = arg.slice("--set-code=".length);
    else if (arg.startsWith("--limit=")) opts.limit = Math.max(1, Number.parseInt(arg.slice("--limit=".length), 10) || 1);
    else if (arg.startsWith("--pages=")) opts.pages = Math.max(1, Number.parseInt(arg.slice("--pages=".length), 10) || 1);
    else if (arg.startsWith("--min-score=")) opts.minScore = Number.parseFloat(arg.slice("--min-score=".length));
    else if (arg === "--json") opts.json = true;
  }
  return opts;
}

async function loadCanonicalCards(supabase, opts) {
  const baseSelect = "slug, canonical_name, canonical_name_native, set_name, set_name_native, card_number, year, language";
  let rows = [];
  if (opts.slugs.length > 0) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select(baseSelect)
      .in("slug", opts.slugs);
    if (error) throw new Error(`canonical_cards lookup: ${error.message}`);
    rows = data ?? [];
  } else if (opts.setCode) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select(`${baseSelect}, card_printings!inner(set_code)`)
      .eq("card_printings.set_code", opts.setCode)
      .eq("language", "JP")
      .limit(opts.limit);
    if (error) throw new Error(`canonical_cards by set lookup: ${error.message}`);
    rows = data ?? [];
  } else if (opts.randomJp > 0) {
    // Sample random JP cards. Use a simple offset trick — not a true
    // uniform sample but good enough for spot-checking.
    const { count, error: countErr } = await supabase
      .from("canonical_cards")
      .select("slug", { count: "exact", head: true })
      .eq("language", "JP");
    if (countErr) throw new Error(`canonical_cards count: ${countErr.message}`);
    const total = count ?? 0;
    const offsets = new Set();
    while (offsets.size < Math.min(opts.randomJp, total)) {
      offsets.add(Math.floor(Math.random() * total));
    }
    for (const off of offsets) {
      const { data } = await supabase
        .from("canonical_cards")
        .select(baseSelect)
        .eq("language", "JP")
        .order("slug")
        .range(off, off);
      if (data && data.length > 0) rows.push(data[0]);
    }
  }
  return rows;
}

function renderResult(card, query, result, opts) {
  if (opts.json) {
    return JSON.stringify({ card, query, result }, null, 2);
  }

  const lines = [];
  lines.push("");
  lines.push(c("=".repeat(80), ANSI.dim));
  lines.push(c(`CANONICAL: ${card.slug}`, ANSI.bold + ANSI.cyan));
  lines.push(`  EN name: ${card.canonical_name ?? "?"}`);
  if (card.canonical_name_native) lines.push(`  JP name: ${c(card.canonical_name_native, ANSI.bold)}`);
  lines.push(`  EN set:  ${card.set_name ?? "?"}`);
  if (card.set_name_native) lines.push(`  JP set:  ${c(card.set_name_native, ANSI.bold)}`);
  lines.push(`  card #:  ${card.card_number ?? "?"}    year: ${card.year ?? "?"}    lang: ${card.language ?? "?"}`);
  lines.push("");
  lines.push(c(`QUERY: ${query.query}`, ANSI.bold));
  lines.push(`  parts: pokemon=${query.parts.pokemonToken ?? "—"} | set=${query.parts.setToken ?? "—"} | era=${query.parts.eraToken ?? "—"}${query.parts.fallback ? " | FALLBACK" : ""}`);
  lines.push("");
  lines.push(`PIPELINE: scraped=${result.inputCount} → afterExclusion=${result.afterExclusion} → accepted=${result.accepted}`);
  lines.push(`  tiers: HIGH=${result.tiers.HIGH}  MEDIUM=${result.tiers.MEDIUM}  LOW=${result.tiers.LOW}`);
  if (result.warnings.length > 0) {
    for (const w of result.warnings) lines.push(c(`  ⚠ ${w}`, ANSI.yellow));
  }
  lines.push("");

  if (result.priceObservations.length === 0) {
    lines.push(c("  NO PRICE OBSERVATIONS PRODUCED", ANSI.red));
  } else {
    lines.push(c("PRICES (median sold, by grade):", ANSI.bold));
    for (const obs of result.priceObservations) {
      const yen = (n) => `¥${n.toLocaleString("en-US")}`;
      lines.push(c(`  [${obs.grade.padEnd(13)}] n=${obs.count.toString().padStart(3)}  median=${yen(obs.median).padStart(10)}  p25=${yen(obs.p25).padStart(10)}  p75=${yen(obs.p75).padStart(10)}  range=${yen(obs.min)}-${yen(obs.max)}`, ANSI.green));
      for (const s of obs.samples.slice(0, 3)) {
        lines.push(c(`     ¥${s.price.toLocaleString("en-US")} (score ${s.score.toFixed(2)}) ${s.title}`, ANSI.dim));
        lines.push(c(`        ${s.url}`, ANSI.dim));
      }
    }
  }

  // Debug: show a few low-tier rejections so the user can see what got dropped
  const lowDetail = result.detail?.tiers?.LOW ?? [];
  if (lowDetail.length > 0 && opts.verbose !== false) {
    lines.push("");
    lines.push(c(`DROPPED (LOW tier — first 3):`, ANSI.dim));
    for (const s of lowDetail.slice(0, 3)) {
      lines.push(c(`  score=${s.score.toFixed(2)} ${s.listing.title.slice(0, 80)}`, ANSI.dim));
      lines.push(c(`    reasons: ${s.reasons.join(" ; ")}`, ANSI.dim));
    }
  }

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const cards = await loadCanonicalCards(supabase, opts);
  if (cards.length === 0) {
    console.error("[match-yahoo-jp] no cards matched the input filters");
    process.exit(1);
  }

  const summaries = [];
  for (const [i, card] of cards.entries()) {
    const query = buildPrecisionQuery(card);
    if (!query.query) {
      console.error(`[match-yahoo-jp] ${i + 1}/${cards.length} ${card.slug} — could not build query (no Pokemon name available)`);
      continue;
    }

    let scrape;
    try {
      scrape = await scrapeYahooJp(query.query, { mode: "closed", maxPages: opts.pages });
    } catch (err) {
      console.error(`[match-yahoo-jp] ${i + 1}/${cards.length} ${card.slug} — scrape failed: ${err.message}`);
      continue;
    }

    const result = selectMatched(scrape.listings, card, { minScore: opts.minScore });
    summaries.push({ card, query, result });

    if (!opts.json) {
      console.log(renderResult(card, query, result, opts));
    }

    // Politeness inter-card delay
    if (i < cards.length - 1) {
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(summaries, null, 2));
  } else {
    // End-of-run summary
    console.log("");
    console.log(c("=".repeat(80), ANSI.dim));
    console.log(c(`SUMMARY: ${summaries.length} canonical card(s) processed`, ANSI.bold));
    let withPrices = 0, withRaw = 0, totalAccepted = 0, totalScraped = 0;
    for (const s of summaries) {
      if (s.result.priceObservations.length > 0) withPrices += 1;
      if (s.result.priceObservations.some((o) => o.grade === "RAW")) withRaw += 1;
      totalAccepted += s.result.accepted;
      totalScraped += s.result.inputCount;
    }
    console.log(`  total scraped: ${totalScraped}, accepted (HIGH+MED): ${totalAccepted}`);
    console.log(`  ${withPrices}/${summaries.length} cards produced ≥1 price observation`);
    console.log(`  ${withRaw}/${summaries.length} cards produced RAW price observations`);
  }
}

main().catch((err) => {
  console.error("[match-yahoo-jp] FAILED:", err);
  process.exit(1);
});
