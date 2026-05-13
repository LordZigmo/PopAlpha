# Snkrdunk API archaeology — Phase 0 complete

_Last updated: 2026-05-13_

## TL;DR

Snkrdunk has a clean public JSON API at `/en/v1/...` that returns full per-listing trading-card data **anonymously, no auth required**. Every listing carries an `isSold` boolean — so authenticated-transaction history is publicly accessible. **Phase 0 is unblocked; the integration can proceed on Path A (API scraper, ~2 weeks build) rather than Path B (Playwright, ~3 weeks).**

The one yellow flag: `robots.txt` has `Disallow: /en/v1/*`. The endpoints are technically public and the page itself calls them, but Snkrdunk's posture asks crawlers not to hit `/en/v1/`. We'll need to be polite (low concurrency, modest rate, transformed-not-resold) and accept that this is a soft norm we'd be violating in spirit if not in letter. Same risk class as the Yahoo! Auctions JP scraper.

## The endpoints

### Primary: per-card listings + sold history
**`GET /en/v1/products/SW---<trading_card_id>/used-listings`**

Returns `{usedListings: [...], product: {...}}`. Each listing has:
- `id`, `listingUID` (unique identifiers)
- `priceAmount` (number, in USD per `currency` field — but stored backend appears to be JPY-converted client-side via `forexFetchTime`)
- `condition` (string: `"A"` / `"B"` / `"C"` / `"D"` / `"PSA 10"` / `"PSA 9"` / `"PSA 8 or under"` / `"BGS 10 BL"` / `"BGS 10 GL"` / `"BGS 9.5"` / `"BGS 9 or under"` / `"ARS 10(+)"` / `"ARS 10"` / `"ARS 9"` / `"ARS 8 or under"` / `"Other Graded"`)
- `conditionDescription` (e.g. "Minor scratches or scuffs")
- **`isSold` boolean** — `true` = completed transaction, `false` = currently listed
- `description` (seller note, often Japanese)
- `numberOfItems` (for bulk lots — should be 0 for single cards)
- `imageUrls`, `thumbnailUrl`

Default page size is 20. Pagination param is `?page=N` (1-based) — verified during Step 1 smoke test. `offset=` and `limit=` are silently ignored. Pages past the last data page return `{usedListings: []}`. Active listings appear mixed with sold on later pages (page 1 of card 91103 was all sold; pages 3-4 had ~7 active mixed in across 75 total). For price aggregation we filter to `isSold=true` regardless — sold transactions ARE the market clearing signal.

### Secondary endpoints
| Endpoint | Returns | Use |
|---|---|---|
| `GET /en/v1/trading-cards/<id>/min-prices-by-conditions` | `{conditionPrices: [{conditionId, conditionName, minPrice, minPriceFormat}]}` | Pre-computed per-condition floor prices. Faster lookup than aggregating from `/used-listings`. |
| `GET /en/v1/streetwears/used-listings/conditions` | `{conditions: [{id, name}]}` | Condition code catalog. Static; fetch once at startup. |
| `GET /en/v1/products/SW---<id>/variations` | `{products: [...]}` | Related/variant products. Useful for canonical-card matching cross-references. |
| `GET /en/v1/products/SW---<id>/related-products` | small JSON | (returned ~15 bytes on test — possibly empty for this card) |

### Catalog discovery
**Sitemap index**: `https://snkrdunk.com/en/sitemap/sitemap-index-en-product-trading-card-single.xml`

→ Lists 8 gzipped sub-sitemaps at `sitemap-en-product-trading-card-single-{0..7}.xml.gz`. Each gz expands to thousands of URLs of the form `<loc>https://snkrdunk.com/en/trading-cards/<id></loc>`. Use these to enumerate every trading-card ID for the bulk backfill.

## Confirmed verifications

- Anonymous GET with bare `User-Agent` + `Accept: application/json` works on all the above endpoints (curl, no cookies, returns 200).
- Response data matches what's rendered on the public web page (verified via Chrome MCP + screenshots on card 91103, "Charizard VMAX HR: PROMO[S-P 104]").
- `isSold` accurately tags sold vs active — the page renders a "SOLD" overlay for matching listings.
- robots.txt: `Disallow: /en/v1/*` for all user-agents. We'd be a soft violator. (See risk note below.)
- No anti-bot challenges encountered across ~50 polite requests during exploration.

## ID namespaces (important)

- **`/en/trading-cards/<id>`** — public web URL. `<id>` is the trading-card integer ID.
- **`SW---<id>`** — the `productCode` used in `/v1/products/...` endpoints. The `<id>` portion matches the trading-card integer ID. Confirmed: trading-card `91103` → product code `SW---91103`.
- **`/v2/products/<id>`** — DIFFERENT id space. This is for sneakers/apparel. Don't conflate.

The `SW---` prefix probably stands for "Streetwear" — Snkrdunk treats trading cards as a subtype of their streetwear table (also visible in endpoints like `/v1/streetwears/91103/sizes` and `/v1/streetwears/used-listings/conditions`).

## Risk note: robots.txt

```
User-agent: *
Disallow: /en/v1/*
```

This is a soft signal asking crawlers not to hit `/en/v1/`. Three honest takes:

1. **Our use isn't crawling.** We hit specific known endpoints for a defined catalog (~14k cards), not blanket-traversing the site.
2. **The data is unambiguously public** — same JSON the web page renders to anonymous users.
3. **But we'd be violating the spirit of the directive.** robots.txt is a community norm; ignoring it is not illegal but is a flag.

Same risk class as the Yahoo! scraper we already shipped. Mitigations: polite rate (~30 req/min, well below "crawler" load), respect HTTP error codes (if Snkrdunk returns 429/403, back off), transform-not-resold (we surface medians in our UX, not raw listings), and never bypass technical controls. We should also be ready to halt cleanly if Snkrdunk asks us to stop — a contactable BD email exists per their site.

## Build plan (refined now that endpoints are known)

**~1.5-2 weeks total**, similar shape to the Yahoo! pipeline:

| Step | Work | Days |
|---|---|---|
| 1 | `scripts/scrape-snkrdunk.mjs` — mirrors `scrape-yahoo-jp.mjs`. Endpoints listed above. Cookie warmup probably unnecessary (already verified anonymous works); Chrome-realistic headers still polite. | 1-2 |
| 2 | Matcher adapter — `lib/jp/matcher.mjs`'s `extractFinish` + `selectMatched` operate on a generic `{title, price}` shape. Snkrdunk listings have richer data (`condition`, `isSold`) — adapter converts to the listing shape the matcher expects, possibly upgrading the matcher to weight Snkrdunk's `condition` field (which is structured, unlike Yahoo!'s parsed-from-title finish detection). | 1-2 |
| 3 | Schema — `snkrdunk_card_prices` table, identical shape to `yahoo_jp_card_prices` (canonical_slug, printing_id, grade, price_usd, price_jpy, fx_rate_used, sample_count, observed_at). Migration recreates the `public_card_metrics` view to also expose `snkrdunk_price_*` columns. | 1 |
| 4 | Orchestrator + cron route — clone of `run-yahoo-jp-pipeline.mjs` and `app/api/cron/run-yahoo-jp-daily/route.ts`. Same auto-halt, same retry, same kill-switch. | 1-2 |
| 5 | Backfill + verify — run on a sample, manually validate matches on the highest-value cards, then full backfill. | 1-2 |
| 6 | iOS surfacing — UX decision: show both Yahoo! and Snkrdunk side-by-side, OR blend by sample weight, OR show the more-confident one. Adds new columns to `CardMetricsResult` + a small UI tweak. | 1 |

## Canonical-card matching strategy

The Snkrdunk product title is in English (we have both `nameEN` from `/variations` and the title from `/used-listings`). Format pattern: `<Pokemon Name>: <Set Code>(<Set Long Name>)` for promos, or `<Pokemon Name> (<Set Long Name>)` for regular set cards. Examples:
- `Charizard VMAX HR: PROMO[S-P 104](S-P Promotional cards)`
- `Blastoise: Old Back/PROMO[PMCG-P No.009](PMCG-P Promotional cards)`

For matching to PopAlpha's `canonical_cards`:
- Extract Pokemon name + set name from the title
- Score against `canonical_cards` filtered to `language='JP'` 
- The set-name mapping work we did for `search_doc_norm` (拡張パック ↔ "Base Set") might need an extra layer for Snkrdunk's set-name conventions (their `S-P` vs `Sword & Shield Promo` etc.), but the existing structure handles most of it.

The Yahoo! matcher's `buildPrecisionQuery` doesn't apply here (Snkrdunk's product IDs map 1:1 to its catalog; we're not searching, we're enumerating by trading-card-ID). Instead the matcher needs a reverse step: given a Snkrdunk product object, find the matching canonical_card.

## Recommendation

**Proceed with Path A (API scraper).** The Phase 0 finding is unambiguous — the endpoints exist, work without auth, return structured per-listing + per-condition data with sold flags. ~1.5-2 weeks to ship end-to-end. Risk profile is comparable to Yahoo! (which we shipped successfully).

If you'd like, the natural next step is the same "send a partnership email + start scraper build in parallel" play we discussed for Yahoo! — Snkrdunk's BD is reachable, and an API partnership would remove the robots.txt soft-violation entirely. But it's optional; not blocking.

Want me to start the actual build (Step 1 above) now, or wait for green light?
