#!/usr/bin/env node
/**
 * Snkrdunk sitemap walker — extracts every trading-card ID into a JSON
 * file for downstream catalog matching.
 *
 * Step A of the catalog-mapper sequence (Step B fetches product names
 * for each ID, Step C matches against canonical_cards, Step D persists).
 * This script intentionally does NOT hit Snkrdunk's /en/v1/ JSON API
 * (which their robots.txt disallows). It only fetches the publicly-
 * advertised sitemaps under /en/sitemap/, which are NOT in the
 * Disallow list and are explicitly designed to be crawled.
 *
 * Architecture:
 *   1. Fetch sitemap-index → list of N sub-sitemap URLs
 *   2. Fetch + gunzip each sub-sitemap → list of /en/trading-cards/<id>
 *      URLs
 *   3. Extract the integer IDs
 *   4. Write the union to tmp/snkrdunk-trading-card-ids.json
 *
 * The output JSON shape:
 *   {
 *     fetchedAt: "2026-05-13T...",
 *     subSitemaps: ["...-0.xml.gz", "...-1.xml.gz", ...],
 *     totalIds: 240000,
 *     idsBySubSitemap: { "...-0.xml.gz": 30000, ... },
 *     ids: [91103, 91104, ..., <integer trading-card IDs>]
 *   }
 *
 * Snkrdunk's catalog at the time of writing has 8 sub-sitemaps with
 * ~30k cards each, totaling ~240k trading-card IDs across all TCGs
 * (Pokemon, Yu-Gi-Oh, OnePiece, etc.). Filtering to Pokemon is Step B's
 * concern — this script extracts all IDs verbatim.
 *
 * Usage:
 *   node scripts/walk-snkrdunk-sitemap.mjs
 *   node scripts/walk-snkrdunk-sitemap.mjs --output=/tmp/custom-path.json
 *   node scripts/walk-snkrdunk-sitemap.mjs --max-sub-sitemaps=2  (smoke test)
 *
 * Polite defaults: 1s between sub-sitemap fetches (8 total fetches —
 * negligible load). All within robots.txt-allowed paths.
 */

import { gunzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SITEMAP_INDEX_URL =
  "https://snkrdunk.com/en/sitemap/sitemap-index-en-product-trading-card-single.xml";
const DEFAULT_OUTPUT = "tmp/snkrdunk-trading-card-ids.json";
const DEFAULT_INTER_FETCH_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    output: DEFAULT_OUTPUT,
    maxSubSitemaps: null,
    delayMs: DEFAULT_INTER_FETCH_DELAY_MS,
    quiet: false,
  };
  for (const a of args) {
    if (a.startsWith("--output=")) opts.output = a.slice("--output=".length);
    else if (a.startsWith("--max-sub-sitemaps=")) opts.maxSubSitemaps = Math.max(1, Number.parseInt(a.slice("--max-sub-sitemaps=".length), 10) || 1);
    else if (a.startsWith("--delay=")) opts.delayMs = Math.max(0, Number.parseInt(a.slice("--delay=".length), 10) || 0);
    else if (a === "--quiet") opts.quiet = true;
  }
  return opts;
}

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse sitemap-index XML → list of sub-sitemap URLs.
 * The XML is on a single line in practice, so we use a regex rather
 * than a full XML parser. Snkrdunk's sitemaps are structured and
 * stable.
 */
function extractSubSitemapUrls(xmlText) {
  const matches = xmlText.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g);
  return [...matches].map((m) => m[1].trim());
}

/**
 * Parse a sub-sitemap XML → list of integer trading-card IDs.
 * The URLs are all under /en/trading-cards/<id> where <id> is a
 * positive integer.
 */
function extractTradingCardIds(xmlText) {
  const ids = [];
  const matches = xmlText.matchAll(/\/trading-cards\/(\d+)/g);
  for (const m of matches) {
    const id = Number.parseInt(m[1], 10);
    if (Number.isFinite(id) && id > 0) ids.push(id);
  }
  return ids;
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = (...args) => opts.quiet || console.log("[walk-snkrdunk-sitemap]", ...args);

  log(`fetching sitemap-index: ${SITEMAP_INDEX_URL}`);
  const indexBuf = await fetchBuffer(SITEMAP_INDEX_URL);
  const subSitemapUrls = extractSubSitemapUrls(indexBuf.toString("utf8"));
  log(`found ${subSitemapUrls.length} sub-sitemap(s)`);

  const subSet =
    opts.maxSubSitemaps != null
      ? subSitemapUrls.slice(0, opts.maxSubSitemaps)
      : subSitemapUrls;
  if (subSet.length !== subSitemapUrls.length) {
    log(`limiting to first ${subSet.length} sub-sitemap(s) (smoke test mode)`);
  }

  const idsBySubSitemap = {};
  const allIds = new Set();
  const startedAt = Date.now();

  for (let i = 0; i < subSet.length; i += 1) {
    const url = subSet[i];
    log(`  [${i + 1}/${subSet.length}] fetching ${url}`);
    const buf = await fetchBuffer(url);
    // Sub-sitemaps are gzipped. Some HTTP clients auto-decode, some don't —
    // detect via the magic header (gzip starts with 1f 8b) and decode if
    // needed.
    let xmlText;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      xmlText = gunzipSync(buf).toString("utf8");
    } else {
      xmlText = buf.toString("utf8");
    }
    const ids = extractTradingCardIds(xmlText);
    idsBySubSitemap[url] = ids.length;
    for (const id of ids) allIds.add(id);
    log(`    → ${ids.length} ID(s) extracted; running total ${allIds.size}`);

    if (i < subSet.length - 1 && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`done in ${elapsedSec}s — ${allIds.size} unique trading-card ID(s) across ${subSet.length} sub-sitemap(s)`);

  // Sort ascending for deterministic output.
  const sortedIds = [...allIds].sort((a, b) => a - b);

  const output = {
    fetchedAt: new Date().toISOString(),
    sitemapIndex: SITEMAP_INDEX_URL,
    subSitemaps: subSet,
    totalIds: sortedIds.length,
    idsBySubSitemap,
    ids: sortedIds,
  };

  const outPath = resolve(opts.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`wrote ${outPath} (${sortedIds.length} IDs)`);
}

main().catch((err) => {
  console.error("[walk-snkrdunk-sitemap] FATAL:", err);
  process.exit(1);
});
