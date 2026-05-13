#!/usr/bin/env node
/**
 * Snkrdunk scraper — Day 1 v0.
 *
 * Provides `scrapeSnkrdunk(tradingCardId, opts)` plus small helpers for
 * the secondary endpoints (variations, min-prices-by-conditions,
 * conditions catalog). Unlike Yahoo! (HTML __NEXT_DATA__), Snkrdunk
 * exposes a clean public JSON API at /en/v1/... that the page itself
 * calls anonymously — no headless browser, no cookie warmup, no HTML
 * parsing required.
 *
 * The primary endpoint is:
 *   GET /en/v1/products/SW---<tradingCardId>/used-listings
 *
 * Each listing carries an `isSold` boolean, so a single query gives us
 * both currently-listed inventory AND completed-transaction history.
 * Conditions are an enum (A/B/C/D/PSA10/PSA9/PSA 8 or under/BGS 10 BL/
 * BGS 10 GL/BGS 9.5/BGS 9 or under/ARS 10(+)/ARS 10/ARS 9/ARS 8 or under/
 * Other Graded), not free-text — so finish disambiguation comes from the
 * product itself (each `productCode` SW---N is one printing), not from
 * title parsing the way Yahoo! requires.
 *
 * Risk note (read before raising request volume):
 *   robots.txt is `Disallow: /en/v1/*` for all user-agents. The endpoint
 *   is public and the page itself uses it, but we'd be violating the
 *   spirit of the soft directive. Same risk class as the Yahoo! scraper.
 *   Mitigations baked into defaults:
 *     - 1 req / 2s (polite, ~30 req/min — well below "crawler" load)
 *     - Honor HTTP error codes (429/403 → caller halts)
 *     - Chrome-realistic headers (no spoofing — we ARE one client)
 *     - Transform-not-resold downstream
 *   Halt cleanly if Snkrdunk's BD contacts us.
 *
 * Usage (CLI):
 *   node scripts/scrape-snkrdunk.mjs 91103
 *   node scripts/scrape-snkrdunk.mjs --trading-card-id=91103 --json
 *   node scripts/scrape-snkrdunk.mjs 91103 --include-variations
 */

const SNKRDUNK_BASE = "https://snkrdunk.com";
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_JITTER_MS = 250;
const REQUEST_TIMEOUT_MS = 25000;
const DEFAULT_MAX_PAGES = 4; // 20 per page * 4 = 80 listings, plenty for medians
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    tradingCardId: null,
    pages: DEFAULT_MAX_PAGES,
    json: false,
    raw: false,
    includeVariations: false,
    includeMinPrices: false,
  };
  for (const arg of args) {
    if (arg.startsWith("--trading-card-id=")) opts.tradingCardId = arg.slice("--trading-card-id=".length);
    else if (arg.startsWith("--pages=")) opts.pages = Math.max(1, Number.parseInt(arg.slice("--pages=".length), 10) || 1);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--raw") opts.raw = true;
    else if (arg === "--include-variations") opts.includeVariations = true;
    else if (arg === "--include-min-prices") opts.includeMinPrices = true;
    else if (!arg.startsWith("--")) opts.tradingCardId = opts.tradingCardId ?? arg;
  }
  return opts;
}

// =============================================================================
// Browser-realistic HTTP layer
// =============================================================================
// Snkrdunk's /en/v1/ endpoints accept bare anonymous GETs — verified in
// Phase 0 with curl + a no-cookies fetch. We still send a Chrome-shaped
// header set as a courtesy and to keep behavior consistent if Snkrdunk
// later adds the same kind of header-completeness check Yahoo!'s
// closedsearch does. The Accept here is JSON (not HTML) because we're
// hitting the API directly, not navigating a page.

function browserHeaders({ referer = null } = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": referer ? "same-origin" : "same-origin",
  };
  if (referer) headers["Referer"] = referer;
  return headers;
}

/**
 * Custom error class so callers (orchestrator, cron) can distinguish
 * "Snkrdunk asked us to back off" from a generic fetch flake. 429/403/503
 * signal possible anti-bot pushback — caller should halt the run, not
 * just retry the single card.
 */
export class SnkrdunkPushbackError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url} — Snkrdunk pushback (halt the run)`);
    this.name = "SnkrdunkPushbackError";
    this.status = status;
    this.url = url;
  }
}

async function fetchJson(url, { referer = null } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: browserHeaders({ referer }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      throw new SnkrdunkPushbackError(res.status, url);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// Endpoints
// =============================================================================

/**
 * Primary endpoint — completed-transaction history for a trading-card
 * product. Returns up to 20 listings per call (`?page=N`, 1-based; `offset=`
 * and `limit=` are silently ignored). Verified during Day-1 probing:
 *   - Card 91103 has 2 pages of data (~40 sold listings), pages 3+ empty.
 *   - All returned listings have isSold=true. The endpoint appears to
 *     be sold-only despite the `isSold` flag in the schema. That's
 *     fine for price aggregation — sold transactions ARE the market
 *     signal we want; current listed asking prices are wishful.
 */
export async function fetchUsedListings(tradingCardId, { page = 1 } = {}) {
  const productCode = `SW---${tradingCardId}`;
  const qp = page > 1 ? `?page=${page}` : "";
  const url = `${SNKRDUNK_BASE}/en/v1/products/${productCode}/used-listings${qp}`;
  const referer = `${SNKRDUNK_BASE}/en/trading-cards/${tradingCardId}`;
  return fetchJson(url, { referer });
}

/**
 * Secondary — pre-computed per-condition floor prices. Cheaper than
 * aggregating from /used-listings when we only need a single "starting
 * at" number per condition.
 */
export async function fetchMinPricesByConditions(tradingCardId) {
  const url = `${SNKRDUNK_BASE}/en/v1/trading-cards/${tradingCardId}/min-prices-by-conditions`;
  const referer = `${SNKRDUNK_BASE}/en/trading-cards/${tradingCardId}`;
  return fetchJson(url, { referer });
}

/**
 * Secondary — variant cross-references (e.g. holo vs reverse-holo). The
 * matcher may use this to map Snkrdunk product IDs to PopAlpha printings.
 */
export async function fetchVariations(tradingCardId) {
  const productCode = `SW---${tradingCardId}`;
  const url = `${SNKRDUNK_BASE}/en/v1/products/${productCode}/variations`;
  const referer = `${SNKRDUNK_BASE}/en/trading-cards/${tradingCardId}`;
  return fetchJson(url, { referer });
}

/**
 * Static condition catalog. Fetch once at startup; cache. Returns
 * `{conditions: [{id, name}]}`.
 */
export async function fetchConditionsCatalog() {
  const url = `${SNKRDUNK_BASE}/en/v1/streetwears/used-listings/conditions`;
  return fetchJson(url, { referer: `${SNKRDUNK_BASE}/en/` });
}

// =============================================================================
// Normalization
// =============================================================================
/**
 * Convert a raw Snkrdunk listing object into our canonical scraper-output
 * shape. Mirrors the field set we already use for YAHOO_JP, so the
 * downstream matcher + writer code can share most plumbing.
 *
 * Key fields:
 *   - source: "SNKRDUNK"
 *   - listingType: "FIXED_PRICE" — Snkrdunk is a fixed-price marketplace
 *     (the listing has an `isSold` boolean; sold = a buyer accepted that
 *     price). Useful for orchestrator code that branches on type.
 *   - mode: "sold" or "active", derived from `isSold`. Lets downstream
 *     code reuse the closed/active split it already has from Yahoo!.
 *   - condition: structured enum (A/B/C/D/PSA 10/...) — Snkrdunk's
 *     killer feature vs. Yahoo!, which only ships condition as
 *     free-text in the title.
 *   - currency: passed through. Snkrdunk's English site reports prices
 *     in USD per the `currency` field in the parent response; the
 *     orchestrator decides whether to use that USD directly or
 *     re-derive from JPY using our own FX (consistent with how Yahoo!
 *     yen prices are converted via DEFAULT_JPY_TO_USD_RATE).
 */
function normalizeListing(raw, currency) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ?? raw.listingUID ?? null;
  if (!id) return null;

  const priceAmount = typeof raw.priceAmount === "number" ? raw.priceAmount : null;
  const isSold = raw.isSold === true;
  const numberOfItems =
    typeof raw.numberOfItems === "number" ? raw.numberOfItems : raw.numberOfItems === null ? null : 0;

  // Skip bulk lots — for per-card price aggregation we only want singles.
  // numberOfItems=0 or 1 means single card; >1 means a lot. Surface it
  // in the output so the matcher/filter layer can choose what to do.
  // (We intentionally do NOT filter here — matcher decides.)
  return {
    source: "SNKRDUNK",
    mode: isSold ? "sold" : "active",
    listingType: "FIXED_PRICE",
    listingId: String(id),
    listingUID: raw.listingUID ?? null,
    title: typeof raw.title === "string" ? raw.title : null,
    price: priceAmount,
    currency: currency ?? raw.currency ?? null,
    condition: typeof raw.condition === "string" ? raw.condition : null,
    conditionDescription:
      typeof raw.conditionDescription === "string" ? raw.conditionDescription : null,
    description: typeof raw.description === "string" ? raw.description : null,
    isSold,
    numberOfItems,
    imageUrls: Array.isArray(raw.imageUrls) ? raw.imageUrls : [],
    thumbnailUrl: typeof raw.thumbnailUrl === "string" ? raw.thumbnailUrl : null,
    forexFetchTime: raw.forexFetchTime ?? null,
    raw, // keep the raw object for debugging; orchestrator drops it before persisting
  };
}

// =============================================================================
// Top-level scraper
// =============================================================================

/**
 * Fetch and normalize all currently-known listings (active + sold) for
 * one Snkrdunk trading-card ID.
 *
 * Returns:
 *   {
 *     tradingCardId: "91103",
 *     productCode:   "SW---91103",
 *     product:       { ...meta from /used-listings response.product, or null },
 *     totalReturned: <number of listings normalized>,
 *     activeCount:   <count where isSold=false>,
 *     soldCount:     <count where isSold=true>,
 *     listings:      [normalizedListing, ...],
 *     variations:    [...] | undefined,        // if opts.includeVariations
 *     minPrices:     { ... } | undefined,      // if opts.includeMinPrices
 *   }
 *
 * Throws SnkrdunkPushbackError on 429/403/503 — caller should halt the
 * full run, not just retry this card.
 */
export async function scrapeSnkrdunk(tradingCardId, opts = {}) {
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const includeVariations = opts.includeVariations === true;
  const includeMinPrices = opts.includeMinPrices === true;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;

  const id = String(tradingCardId).trim();
  if (!id) throw new Error("scrapeSnkrdunk: tradingCardId is required");

  const productCode = `SW---${id}`;

  // Page through /used-listings until we hit an empty page or maxPages.
  // Most cards return everything on page 1; only popular cards (Charizard
  // VMAX HR etc) need 2-4 pages. SnkrdunkPushbackError propagates so the
  // orchestrator halts on 429/403/503.
  const aggregatedListings = [];
  let product = null;
  let topLevelCurrency = null;
  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) await sleep(delayMs + Math.random() * jitterMs);
    const listingsRes = await fetchUsedListings(id, { page });
    pagesFetched += 1;
    const rawList = Array.isArray(listingsRes?.usedListings) ? listingsRes.usedListings : [];
    if (page === 1) {
      product = listingsRes?.product ?? null;
      topLevelCurrency = listingsRes?.currency ?? product?.currency ?? null;
    }
    if (rawList.length === 0) break; // past the end
    aggregatedListings.push(...rawList.map((r) => normalizeListing(r, topLevelCurrency)).filter(Boolean));
    if (rawList.length < 20) break; // partial page = last page
  }

  // Currency lives per-listing in the response shape we've seen
  // (e.g. card 91103: top-level currency is null, each listing carries
  // currency: "USD"). Fall back to the first listing's currency for the
  // result-level summary so downstream code has a single value to use.
  const effectiveCurrency =
    topLevelCurrency ?? aggregatedListings.find((l) => l.currency)?.currency ?? null;
  const soldCount = aggregatedListings.filter((l) => l.isSold).length;
  const activeCount = aggregatedListings.length - soldCount;

  const result = {
    tradingCardId: id,
    productCode,
    product,
    currency: effectiveCurrency,
    pagesFetched,
    totalReturned: aggregatedListings.length,
    activeCount,
    soldCount,
    listings: aggregatedListings,
  };

  if (includeVariations) {
    // Polite spacing before secondary call.
    await sleep(delayMs + Math.random() * jitterMs);
    try {
      const variationsRes = await fetchVariations(id);
      result.variations = Array.isArray(variationsRes?.products) ? variationsRes.products : [];
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) throw err;
      console.error(`[scrape-snkrdunk] variations fetch failed for ${id}:`, err.message ?? err);
      result.variations = null;
    }
  }

  if (includeMinPrices) {
    await sleep(delayMs + Math.random() * jitterMs);
    try {
      const minPricesRes = await fetchMinPricesByConditions(id);
      result.minPrices = Array.isArray(minPricesRes?.conditionPrices)
        ? minPricesRes.conditionPrices
        : [];
    } catch (err) {
      if (err instanceof SnkrdunkPushbackError) throw err;
      console.error(`[scrape-snkrdunk] min-prices fetch failed for ${id}:`, err.message ?? err);
      result.minPrices = null;
    }
  }

  return result;
}

// =============================================================================
// CLI entrypoint
// =============================================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv);
  if (!opts.tradingCardId) {
    console.error(
      "usage: node scripts/scrape-snkrdunk.mjs <trading_card_id> [--json] [--raw] [--include-variations] [--include-min-prices]",
    );
    process.exit(1);
  }

  scrapeSnkrdunk(opts.tradingCardId, {
    maxPages: opts.pages,
    includeVariations: opts.includeVariations,
    includeMinPrices: opts.includeMinPrices,
  })
    .then((result) => {
      // Strip the bulky `raw` field unless --raw is set, otherwise
      // --json output is overwhelmed by it.
      const listingsForOutput = opts.raw
        ? result.listings
        : result.listings.map(({ raw, ...rest }) => rest);
      const outputResult = { ...result, listings: listingsForOutput };

      if (opts.json) {
        console.log(JSON.stringify(outputResult, null, 2));
        return;
      }

      const cur = result.currency ?? "?";
      const productName = result.product?.nameEN ?? result.product?.name ?? "(unknown)";
      console.log(`\n[scrape-snkrdunk] card: ${result.tradingCardId} (${result.productCode})`);
      console.log(`[scrape-snkrdunk] product: ${productName}`);
      console.log(
        `[scrape-snkrdunk] returned: ${result.totalReturned} listings (${result.activeCount} active, ${result.soldCount} sold) in ${cur}\n`,
      );
      const sample = opts.raw ? listingsForOutput : listingsForOutput.slice(0, 20);
      for (const [i, l] of sample.entries()) {
        const price = l.price != null ? `${cur} ${l.price.toLocaleString("en-US")}` : "—";
        const sold = l.isSold ? "[SOLD]" : "[ACTIVE]";
        const cond = l.condition ? ` ${l.condition}` : "";
        const lot = l.numberOfItems && l.numberOfItems > 1 ? ` (lot of ${l.numberOfItems})` : "";
        console.log(`${(i + 1).toString().padStart(3, " ")}. ${sold}${cond} ${price}${lot}`);
        if (l.conditionDescription) {
          console.log(`     ${l.conditionDescription.slice(0, 110)}`);
        }
        if (l.description) {
          const snippet = l.description.replace(/\s+/g, " ").slice(0, 110);
          if (snippet) console.log(`     "${snippet}"`);
        }
      }
      if (result.variations !== undefined) {
        console.log(
          `\n[scrape-snkrdunk] variations: ${Array.isArray(result.variations) ? result.variations.length : 0}`,
        );
      }
      if (result.minPrices !== undefined) {
        console.log(
          `[scrape-snkrdunk] min-prices: ${Array.isArray(result.minPrices) ? result.minPrices.length : 0} condition buckets`,
        );
      }
      console.log();
    })
    .catch((err) => {
      if (err instanceof SnkrdunkPushbackError) {
        console.error("[scrape-snkrdunk] PUSHBACK:", err.message);
        process.exit(2);
      }
      console.error("[scrape-snkrdunk] FAILED:", err);
      process.exit(1);
    });
}
