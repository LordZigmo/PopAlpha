# SEO & GEO Ranking Roadmap

Last updated: 2026-06-15

This is the standing plan for improving PopAlpha's organic search (Google/Bing) and
generative-engine (ChatGPT / Perplexity / Gemini / AI Overviews) visibility. It is
sequenced deliberately: **build baseline ranking power on-site first, then send
backlinks** so authority lands on pages already primed to convert it into rankings.

## Current diagnosis (2026-06-15)

Evidence gathered from live prod + Google Search Console + Bing Webmaster Tools:

- **Indexing is not the bottleneck.** Bing has ~4.3k pages indexed. `robots.txt` is
  correct — the only "blocked" entry is `accounts.popalpha.ai` (Clerk auth), which
  should be blocked.
- **Ranking is the bottleneck, gated by authority.** `Backlinks: 0` on every sampled
  page; impressions in the single digits; 0 clicks. Indexed-but-invisible.
- **On-page gaps that cap the ranking ceiling** (the focus of this roadmap):
  - Card pages (`/c/[slug]`) had **zero structured data** — the 20k money pages were
    invisible to rich results and to LLM citation.
  - The logged-out **homepage emits zero crawlable `/c/` or `/sets/` links** — the
    highest-authority page passes no equity to the catalog.
  - Titles/H1s were **not query-targeted** (no "price / value / worth").
  - Some catalog pages are **heavy** (`/sets` ~790KB, set pages ~690KB, `/data` ~550KB).

What is already solid (do not rebuild): `app/sitemap.ts`, `app/robots.ts`, per-route
`generateMetadata` + canonicals, per-card dynamic OG images, and the rich JSON-LD on
the `/compare/*` pages.

## Roadmap

Ordered by leverage. Phases 1–2 are a single card-page template change that
propagates to all ~20k pages.

### Phase 1 — Structured data on the money pages  ✅ in progress (this PR)
- `Product` + `AggregateOffer` on `/c/[slug]` — honesty-gated: a price is only
  emitted when `resolveDisplayedMarketPrice` classifies it `live` / `abundant` /
  `stale_recent` (mirrors the OG-image gate). `AggregateOffer` (not `Offer`) because
  PopAlpha aggregates observed market value and does not sell cards.
- `BreadcrumbList` on `/c/[slug]` and `/sets/[setName]`.
- `FAQPage` on `/c/[slug]` (GEO value — note Google deprecated FAQ rich results for
  non-gov/health, so the win here is LLM citation + visible content depth).
- `Organization` + `WebSite` (with `SearchAction` sitelinks searchbox) on the homepage.

### Phase 2 — Query-targeted titles + citable copy  ✅ in progress (this PR)
- Card titles → append "Price & Value"; descriptions lead with "How much is X worth?".
- A unique, **dated, sourced** intro sentence per card ("As of <date>, its estimated
  raw market price is $X") — the differentiator vs. the templated look and the exact
  sentence LLMs quote. Rendered as crawlable server HTML, honesty-gated identically.

### Phase 3 — Feed equity from the top + build hubs  ⏳ next
- Homepage: link movers → their card pages; link `/sets` + top sets/cards (stop being
  a crawl dead end).
- `/pokemon/[name]` hub pages ("charizard cards") — capture head terms **and** create
  a second internal-link hub funneling authority to every printing.

### Phase 4 — Discovery + page experience  ⏳
- Add card + set pages to `app/sitemap.ts` via `generateSitemaps()` chunking
  (50k URLs/file cap), prioritized by `refresh_tier`. Google needs the map; Bing
  found them by crawl, Google has not.
- Trim the 500–800KB pages (paginate / lazy-load); check Core Web Vitals + mobile.

### Phase 5 — E-E-A-T / trust signals  ⏳
- Link a "How we calculate this price" methodology page from every card page; surface
  "data updated <date>" + sources (eBay, TCGPlayer, Yahoo! JP, Snkrdunk). Pricing is
  money-adjacent (trust-sensitive) content; provenance is both a ranking signal and
  citation bait, and it is a genuine PopAlpha advantage currently hidden.

## Off-site (not code — the real authority lever)

Tracked here so it is not forgotten, but executed outside the repo:
- Link `popalpha.ai` from the App Store listing + inside the iOS app.
- Get into "best Pokémon card price app" roundups (the `/compare/*` pages target these).
- Genuine presence in r/PokemonTCG / r/pkmntcg; drive **branded search** ("PopAlpha").
- **Data-report content engine** — monthly market reports / biggest movers / most
  valuable cards using PopAlpha's proprietary data (incl. JP-native + EN↔JP arbitrage).
  Journalists link to data; LLMs cite dated, sourced numbers. Highest-leverage backlink
  + citation flywheel that fits PopAlpha specifically.

## Measurement
- **Google Search Console**: submit the (expanded) sitemap; watch indexation climb.
- **Bing Webmaster Tools**: sitemap submitted 2026-06-15; consider IndexNow (Bing/Yandex
  only — Google ignores it) once Phase 4 lands.
- **PostHog**: segment organic landing pages; add an AI-referrer filter (`chatgpt.com`,
  `perplexity.ai`, `gemini.google.com`) to quantify GEO traffic separately.
