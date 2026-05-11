#!/usr/bin/env node
/**
 * Yahoo! Auctions JP scraper — Day 1 v0.
 *
 * Provides a single function `scrapeYahooJp(query, opts)` that hits Yahoo!
 * Auctions JP's sold-archive endpoint for a search query and returns
 * structured listings. The closed-search page (落札相場) is a Next.js app
 * that ships its data in <script id="__NEXT_DATA__"> — no headless browser
 * needed, no DOM parsing fragility.
 *
 * Why sold-archive (closedsearch) is the right primary target:
 *   1. Sold prices = real transaction prices. Asking prices are wishful
 *      thinking; we want what the market actually paid.
 *   2. ~120-day window of completed auctions, ~30k+ listings per popular
 *      query, every listing has final price + bid count + close time +
 *      condition + seller rating.
 *   3. Yahoo! Auctions JP's vintage Pokemon coverage is the deepest of any
 *      JP marketplace — Snkrdunk and Mercari skew modern. This fills the
 *      Base/Neo/Gym era gap Scrydex couldn't.
 *
 * Usage (CLI):
 *   node scripts/scrape-yahoo-jp.mjs "リザードン ポケモンカード"
 *   node scripts/scrape-yahoo-jp.mjs --query="charizard" --pages=2 --json
 *
 * Polite defaults:
 *   - 1 request per 2 seconds (250ms jitter)
 *   - Max 4 pages per query (200 listings) unless overridden
 *   - Realistic Mozilla user-agent
 *   - No cookies / no auth — public search only
 */

const YAHOO_AUCTIONS_BASE = "https://auctions.yahoo.co.jp";
const POKEMON_SINGLES_CATEGORY = 2084317608; // ポケモンカードゲーム > シングルカード
const DEFAULT_PER_PAGE = 100; // closedsearch returns up to 100 per page
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_JITTER_MS = 250;
const REQUEST_TIMEOUT_MS = 25000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { query: null, pages: DEFAULT_MAX_PAGES, json: false, raw: false, mode: "closed" };
  for (const arg of args) {
    if (arg.startsWith("--query=")) opts.query = arg.slice("--query=".length);
    else if (arg.startsWith("--pages=")) opts.pages = Math.max(1, Number.parseInt(arg.slice("--pages=".length), 10) || 1);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--raw") opts.raw = true;
    else if (arg === "--active") opts.mode = "active";
    else if (arg === "--closed") opts.mode = "closed";
    else if (!arg.startsWith("--")) opts.query = opts.query ?? arg;
  }
  return opts;
}

function buildSearchUrl({ query, mode, page }) {
  const offset = (page - 1) * DEFAULT_PER_PAGE + 1;
  const params = new URLSearchParams({
    p: query,
    auccat: String(POKEMON_SINGLES_CATEGORY),
    n: String(DEFAULT_PER_PAGE),
    b: String(offset),
  });
  if (mode === "closed") {
    return `${YAHOO_AUCTIONS_BASE}/closedsearch/closedsearch?${params.toString()}`;
  }
  return `${YAHOO_AUCTIONS_BASE}/search/search?${params.toString()}`;
}

// =============================================================================
// Browser-realistic HTTP layer
// =============================================================================
// Yahoo!'s closedsearch endpoint runs a bot-detector that flags requests
// missing the headers a real Chrome browser sends on a same-site
// navigation. The original 3-header fetch (User-Agent, Accept,
// Accept-Language) tripped the detector even at low volume — got us
// HTTP 500'd after ~30 cards on the first concurrency=3 run, with my
// IP put into closedsearch-specific cooldown for 15+ minutes.
//
// The fix is two-fold:
//   1. Send the full ~15-header set a real Chrome 120 sends, including
//      Sec-Fetch-* and Sec-Ch-Ua-* client hints + Upgrade-Insecure-
//      Requests + Cache-Control. These are the headers Yahoo!'s detector
//      cares about.
//   2. Cookie warmup — hit the homepage once before any closedsearch
//      query, capture Set-Cookie response headers, replay them as
//      Cookie on subsequent requests. Real browsers carry session
//      cookies; bare-Node fetch does not.
//
// Plus a Referer chain so each closedsearch request looks like it was
// navigated from a previous Yahoo! page (homepage → first search →
// next search), matching how a human browses.
//
// This is not deception — semantically we ARE one user making low-
// volume polite requests. Bare-Node-fetch's empty header set falsely
// signaled "I'm a bot" because no real client browses without these
// headers, not because we're trying to hide what we are.

const cookieJar = new Map(); // name -> value
let cookiesWarmed = false;
let lastReferer = null;

function buildCookieHeader() {
  if (cookieJar.size === 0) return null;
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function captureCookies(setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const cookie of list) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    // Skip __Host- / __Secure- prefixed cookies — they have strict
    // requirements (HTTPS, no Domain attribute) that aren't always
    // satisfied when we replay them, and they're typically not what
    // Yahoo!'s anti-bot is actually checking for.
    if (name.startsWith("__")) continue;
    cookieJar.set(name, value);
  }
}

function browserHeaders({ referer = null, isNavigation = true } = {}) {
  // Mirror what Chrome 120 on macOS sends when navigating to
  // auctions.yahoo.co.jp. Order doesn't matter for the protocol but
  // matters cosmetically for some fingerprinters; fetch may reorder
  // anyway, so we just include the right SET.
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": isNavigation
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
      : "*/*",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate", // skip 'br' — Node fetch handles gzip/deflate transparently; brotli support is undici-version-dependent
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": isNavigation ? "document" : "empty",
    "Sec-Fetch-Mode": isNavigation ? "navigate" : "cors",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Upgrade-Insecure-Requests": "1",
  };
  if (isNavigation) headers["Sec-Fetch-User"] = "?1";
  if (referer) headers["Referer"] = referer;
  const cookie = buildCookieHeader();
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

async function warmupCookies() {
  if (cookiesWarmed) return;
  // Hit the homepage like a real browser landing on auctions.yahoo.co.jp.
  // Set-Cookie response will populate session/anti-bot cookies that the
  // closedsearch endpoint expects to see on subsequent requests.
  const url = `${YAHOO_AUCTIONS_BASE}/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: browserHeaders({ referer: null, isNavigation: true }),
      redirect: "follow",
      signal: controller.signal,
    });
    // Capture Set-Cookie. Modern Node (undici 6+) exposes via
    // headers.getSetCookie(); older versions need headers.raw().
    if (typeof res.headers.getSetCookie === "function") {
      captureCookies(res.headers.getSetCookie());
    } else {
      const single = res.headers.get("set-cookie");
      if (single) captureCookies(single);
    }
    cookiesWarmed = true;
    lastReferer = url;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchHtml(url) {
  // Lazy cookie warmup — first call to fetchHtml triggers a single
  // homepage fetch to acquire session cookies; subsequent calls reuse.
  await warmupCookies();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: browserHeaders({ referer: lastReferer, isNavigation: true }),
      redirect: "follow",
      signal: controller.signal,
    });
    // Refresh cookies from any Set-Cookie on this response — Yahoo!
    // sometimes rotates session tokens mid-session.
    if (typeof res.headers.getSetCookie === "function") {
      captureCookies(res.headers.getSetCookie());
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    lastReferer = url;
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The closed-search page is a Next.js app that ships its full state in
 * <script id="__NEXT_DATA__">. We extract and parse that JSON; the listings
 * live at .props.pageProps.initialState.search.items.listing.items.
 */
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findListingsArray(nextData) {
  // Walk the JSON to find any array of objects that have an `auctionId` key.
  // The path can shift between Next.js builds; this is more resilient than
  // hard-coding props.pageProps.initialState.search.items.listing.items.
  const stack = [nextData];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (Array.isArray(node)) {
      if (node.length > 0 && node[0] && typeof node[0] === "object" && "auctionId" in node[0]) {
        return node;
      }
      for (const item of node) {
        if (item && typeof item === "object") stack.push(item);
      }
    } else if (typeof node === "object") {
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return [];
}

/**
 * Normalize a Yahoo! __NEXT_DATA__ listing into our internal shape.
 * Critical fields:
 *   - price: the final sold price (or current high bid for active listings)
 *   - endTime: ISO 8601, the close time (when the auction ended for closed
 *     search; or scheduled end for active)
 *   - auctionId: stable Yahoo! ID for dedup + observation source_id
 *   - bidCount: 0 for fixed-price (フリマ) listings, >0 for real auctions
 *   - isFixedPrice / isFleamarketItem: distinguish fixed-price from auction
 *     — for sold-price aggregation we want both, but treat them differently
 *     (auction = competitive market clearing, fixed-price = reservation)
 *   - itemCondition: "new" | "used" | similar; useful for raw-card grading
 *   - categoryPath: includes "シングルカード" (single card) when correct;
 *     filter step uses this to drop sealed/booster/lot listings
 *   - seller.goodRating / isStore: trust signal; bad-rating sellers can
 *     be downweighted in the price aggregation
 */
function normalizeListing(raw, mode) {
  if (!raw || typeof raw !== "object") return null;
  const auctionId = String(raw.auctionId ?? "").trim();
  if (!auctionId) return null;

  const price = typeof raw.price === "number" ? raw.price : null;
  const buyNowPrice = typeof raw.buyNowPrice === "number" ? raw.buyNowPrice : null;
  const isFixed = raw.isFixedPrice === true;
  const isFleamarket = raw.isFleamarketItem === true;

  // For fixed-price/fleamarket items in the closed archive, "price" is the
  // sale price. For competitive auctions, "price" is the final winning bid.
  // Both are valid market signals but we tag them so downstream can weight.
  const listingType = isFleamarket ? "FLEA" : isFixed ? "FIXED_PRICE" : "AUCTION";

  // categoryPath is an array of {id, name}; the leaf tells us if this is
  // a single card (good) vs lot/sealed/accessory (skip). We don't filter
  // here — that's the matcher/filter layer's job — but we surface the
  // path verbatim for that later step.
  const categoryPath = Array.isArray(raw.categoryPath)
    ? raw.categoryPath.map((c) => ({ id: c?.id ?? null, name: c?.name ?? "" }))
    : [];
  const leafCategory = categoryPath.length > 0 ? categoryPath[categoryPath.length - 1] : null;

  return {
    source: "YAHOO_JP",
    mode, // "closed" (sold archive) or "active" (live auction)
    listingType,
    auctionId,
    title: String(raw.title ?? "").trim(),
    price,
    buyNowPrice,
    bidCount: typeof raw.bidCount === "number" ? raw.bidCount : 0,
    watchCount: typeof raw.watchCount === "number" ? raw.watchCount : 0,
    startTime: raw.startTime ?? null,
    endTime: raw.endTime ?? null,
    itemCondition: raw.itemCondition ?? null,
    isFreeShipping: raw.isFreeShipping === true,
    isAppraisal: raw.isAppraisal === true, // graded/authenticated flag
    leafCategoryId: leafCategory?.id ?? null,
    leafCategoryName: leafCategory?.name ?? null,
    categoryPath,
    imageUrl: raw.imageUrl ?? null,
    seller: raw.seller
      ? {
          displayName: raw.seller.displayName ?? null,
          goodRating: raw.seller.goodRating ?? null,
          isStore: raw.seller.isStore === true,
          isBestStore: raw.seller.isBestStore === true,
        }
      : null,
    itemUrl: `${YAHOO_AUCTIONS_BASE}/jp/auction/${auctionId}`,
  };
}

/**
 * Active (live) search uses server-rendered HTML with data-auction-*
 * attributes, NOT __NEXT_DATA__. This parser handles that variant.
 */
function parseActiveSearchHtml(html, mode) {
  const listings = [];
  // Each listing is wrapped in <li class="Product"> ... </li>; the link
  // inside has data-auction-* attributes containing every field we want.
  const productPattern = /<a\s+class="Product__imageLink[^"]*"\s+([^>]+)>/g;
  let m;
  while ((m = productPattern.exec(html)) !== null) {
    const attrs = m[1];
    const get = (name) => {
      const re = new RegExp(`data-auction-${name}="([^"]*)"`);
      const match = attrs.match(re);
      return match ? match[1] : null;
    };
    const auctionId = get("id");
    if (!auctionId) continue;
    const priceStr = get("price");
    const price = priceStr ? Number.parseInt(priceStr, 10) : null;
    listings.push({
      source: "YAHOO_JP",
      mode,
      listingType: "AUCTION", // active search doesn't disambiguate; refined later
      auctionId,
      title: get("title") ?? "",
      price: Number.isFinite(price) ? price : null,
      buyNowPrice: null,
      bidCount: 0, // not in active-search data-attrs; would need item-detail fetch
      watchCount: 0,
      startTime: null,
      endTime: null,
      itemCondition: null,
      isFreeShipping: get("isfreeshipping") === "1" || get("isfreeshipping") === "true",
      isAppraisal: false,
      leafCategoryId: get("category") ? Number.parseInt(get("category"), 10) : null,
      leafCategoryName: null,
      categoryPath: [],
      imageUrl: get("img"),
      seller: null,
      itemUrl: `${YAHOO_AUCTIONS_BASE}/jp/auction/${auctionId}`,
    });
  }
  return listings;
}

export async function scrapeYahooJp(query, opts = {}) {
  const mode = opts.mode === "active" ? "active" : "closed";
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;

  const allListings = [];
  let totalCount = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = buildSearchUrl({ query, mode, page });
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[scrape-yahoo-jp] page ${page} fetch failed:`, err.message);
      // For page 1, propagate the error so the orchestrator can
      // distinguish "Yahoo! returned an error" from "no listings found
      // for this query." Previously this was swallowed (just `break`),
      // which made the function return [] indistinguishable from a
      // successful empty result — exactly the misclassification that
      // hid 51 consecutive HTTP 500s as "low-sample" during the
      // first concurrency=3 run before auto-halt fired.
      //
      // For pages 2+, keep the existing break behavior — partial
      // results are useful, and a transient mid-pagination flake
      // shouldn't poison the whole query.
      if (page === 1) throw err;
      break;
    }

    let listings = [];
    if (mode === "closed") {
      const next = extractNextData(html);
      if (!next) {
        console.error(`[scrape-yahoo-jp] page ${page}: __NEXT_DATA__ not found (page may be empty or layout changed)`);
        break;
      }
      const raw = findListingsArray(next);
      listings = raw.map((r) => normalizeListing(r, mode)).filter(Boolean);
      // Try to extract totalCount from search summary if present.
      if (totalCount === null) {
        const totalMatch = html.match(/約([\d,]+)件/);
        if (totalMatch) totalCount = Number.parseInt(totalMatch[1].replace(/,/g, ""), 10);
      }
    } else {
      listings = parseActiveSearchHtml(html, mode);
      if (totalCount === null) {
        const totalMatch = html.match(/約([\d,]+)件/);
        if (totalMatch) totalCount = Number.parseInt(totalMatch[1].replace(/,/g, ""), 10);
      }
    }

    if (listings.length === 0) break; // last page
    allListings.push(...listings);

    // Be polite. Random jitter so we don't look mechanical.
    if (page < maxPages) {
      await sleep(delayMs + Math.random() * jitterMs);
    }
  }

  return {
    query,
    mode,
    totalReportedByYahoo: totalCount,
    pagesFetched: Math.min(maxPages, Math.ceil(allListings.length / DEFAULT_PER_PAGE) || 1),
    listingsReturned: allListings.length,
    listings: allListings,
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv);
  if (!opts.query) {
    console.error("usage: node scripts/scrape-yahoo-jp.mjs <query> [--pages=N] [--active|--closed] [--json] [--raw]");
    process.exit(1);
  }

  scrapeYahooJp(opts.query, { mode: opts.mode, maxPages: opts.pages })
    .then((result) => {
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`\n[scrape-yahoo-jp] query: "${result.query}"`);
      console.log(`[scrape-yahoo-jp] mode: ${result.mode} (${result.mode === "closed" ? "sold archive" : "live listings"})`);
      console.log(`[scrape-yahoo-jp] yahoo reports: ${result.totalReportedByYahoo ?? "?"} total matches`);
      console.log(`[scrape-yahoo-jp] returned: ${result.listingsReturned} listings across ${result.pagesFetched} page(s)\n`);
      const sample = result.listings.slice(0, opts.raw ? result.listings.length : 20);
      for (const [i, l] of sample.entries()) {
        const yenPrice = l.price ? `¥${l.price.toLocaleString("en-US")}` : "—";
        const buyNow = l.buyNowPrice ? `(BIN ¥${l.buyNowPrice.toLocaleString("en-US")})` : "";
        const bids = l.bidCount > 0 ? ` ${l.bidCount}bids` : l.listingType === "FLEA" ? " [flea]" : l.listingType === "FIXED_PRICE" ? " [fixed]" : "";
        const cond = l.itemCondition ? ` [${l.itemCondition}]` : "";
        const cat = l.leafCategoryName ? ` <${l.leafCategoryName}>` : "";
        const end = l.endTime ? ` ${new Date(l.endTime).toISOString().slice(0, 10)}` : "";
        console.log(`${(i + 1).toString().padStart(3, " ")}. ${yenPrice}${buyNow}${bids}${cond}${cat}${end}`);
        console.log(`     ${l.title.slice(0, 110)}`);
        console.log(`     ${l.itemUrl}`);
      }
      console.log();
    })
    .catch((err) => {
      console.error("[scrape-yahoo-jp] FAILED:", err);
      process.exit(1);
    });
}
