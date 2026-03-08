# PopAlpha

PopAlpha is a Next.js app for alternative-asset data workflows.

## PSA cert lookup vertical slice

This repo includes a simple end-to-end cert lookup flow:
- UI page at `/` with a cert search bar.
- Server API at `GET /api/psa/cert?cert=<CERT_NO>`.
- Server-side PSA calls only (token never sent to browser).
- Supabase cache table (`psa_cert_cache`) with 24-hour TTL behavior.
- Supabase lookup logs (`psa_cert_lookup_logs`) for observability.

- Private sales API (server routes):
  - `GET /api/private-sales?cert=<CERT_NO>`
  - `POST /api/private-sales`

## Printing labels

Printings are the unit for holo/reverse/edition labels.
Canonical cards group identities, while `card_printings` carries label-correct finish and edition metadata.

For Pokemon TCG ingestion, label normalization is rule-driven via `label_normalization_rules`.
To patch mislabels without a full re-import, insert or update higher-priority rules (lower `priority` value wins) for:
- `match_type='variant_key'` (most common for `tcgplayer.prices` keys)
- `match_type='rarity'` / `subtype`
- `match_type='name_regex'` / `set_regex` for targeted cleanup

## eBay Browse integration (read-only)

Live listings on `/c/[slug]` use a server-side proxy route: `GET /api/ebay/browse`.
Set these environment variables in Vercel (Production and Preview as needed):
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_ENV` (`production` or `sandbox`, defaults to `production`)

## Set Summary pipeline

Set pages and homepage rankings should read from precomputed set-level caches, not compute aggregates on each request.

Core tables:
- `variant_price_latest`: latest provider-backed price per variant cohort.
- `variant_price_daily`: daily close rollup per variant cohort (used for 7D / 30D deltas).
- `variant_signals_latest`: latest derived signal state per variant cohort.
- `variant_sentiment_latest`: optional hook for open question vote aggregates.
- `set_finish_summary_latest`: current finish-type breakdown per set.
- `set_summary_snapshots`: daily set-level snapshots keyed by `(set_id, as_of_date)`.

Metric definitions:
- `market_cap`: sum of the primary variant for each card in the set.
- Primary variant fallback:
  - Prefer `NON_HOLO` when present.
  - Otherwise pick the most liquid variant (highest 30D observation count, then most recent observation).
- `market_cap_all_variants`: sum of all current variant prices in the set.
- `change_7d_pct` / `change_30d_pct`: percent move versus the set's aggregated 7-day / 30-day prior daily closes.
- `heat_score`: `0.60 * avg_abs_change_7d + 0.25 * normalized_activity_30d + 0.15 * breakout_density`.
- `breakout_count`, `value_zone_count`, `trend_bullish_count`: counts of primary variants above the current thresholds in `variant_signals_latest`.
- `sentiment_up_pct`: weighted average of `variant_sentiment_latest.sentiment_up_pct` by vote count when available.

Refresh cadence:
- `sync-justtcg-prices` incrementally refreshes set summary artifacts for changed variants after ingest writes.
- `GET /api/cron/refresh-set-summaries` runs daily at `09:00 UTC` via `vercel.json` for a full rebuild.

Backfill:
```bash
npm run sets:backfill-summaries
```

Optional flags:
- `--days=30` controls the historical window (max 90).
- `--refreshPipeline=0` skips the initial full latest-table refresh.

Wiring a set into the pipeline (generalized across all sets):
1. **Canonical cards + card_printings** – Ensure the set exists with EN printings (via Scrydex canonical import or provider-specific import).
2. **Provider ingest + match** – Run JustTCG + Scrydex ingest and normalized match so `variant_metrics` and `price_history_points` get populated for that set’s printings.
3. **Backfill** – Run `npm run sets:backfill-summaries` so `set_finish_summary_latest` and `set_summary_snapshots` are refreshed for all sets (including the new one). Cron does this daily; the script chunks by set and by variant keys to avoid timeouts.
4. **Validate** – `python3 -m pytest -q tests_py/test_set_pipeline_wired.py` asserts every set with card_printings has at least one row in the set-summary views. Sets that have printings but no provider ingest/match yet will appear in the failure message; run ingest and match for those sets, then backfill again.

To see **how many** sets are fully wired (historical cache, fresh snapshot, sorted, finish summary), run:
`python3 -m pytest tests_py/test_set_pipeline_wired.py::test_count_fully_wired_sets -s`
It prints e.g. "Fully wired: 18 of 20 sets" and lists any shortfall with reasons.

Extending to new providers:
- Keep provider-specific ingestion logic writing into `price_history_points` and `variant_metrics`.
- Reuse the same canonical `variant_ref` / `printing_id` identity.
- The set summary SQL reads provider-agnostic latest/daily tables, so adding a provider should not require rewriting the set snapshot pipeline.

## Scrydex canonical importer (chunked, production-safe)

Primary route: `POST /api/admin/import/scrydex-canonical`  
Compatibility route: `POST /api/admin/import/pokemontcg-canonical` (shim to Scrydex)

Query params:
- `pageStart` (default `1`)
- `maxPages` (default: `1` in production, `3` locally, capped at `5`)
- `pageSize` (default `100`, capped at `100`)
- `expansionId` (optional, e.g. `sv4`)
- `dryRun` (optional boolean)

**Scrydex docs/auth:** Use Scrydex Pokemon API docs and dashboard: [scrydex.com](https://scrydex.com/).  
Set both in `.env.local`:
- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`
See also: `docs/SCRYDEX_SETUP.md` for endpoint/header details (`X-Api-Key`, `X-Team-ID`).

If `ADMIN_SECRET` is set, include request header:
- `x-admin-secret: <ADMIN_SECRET>`

Examples:

Import one page:
```bash
curl -X POST "https://popalpha.ai/api/admin/import/scrydex-canonical?pageStart=1&maxPages=1"
```

Import next chunk:
```bash
curl -X POST "https://popalpha.ai/api/admin/import/scrydex-canonical?pageStart=2&maxPages=1"
```

Import a specific set:
```bash
curl -X POST "https://popalpha.ai/api/admin/import/scrydex-canonical?expansionId=sv4&pageStart=1&maxPages=2"
```

Import all sets (full Pokemon TCG catalog; 100+ sets):
- Start the dev server (`npm run dev`), then in another terminal run:
  `npm run import:scrydex-all`
- The script paginates through all cards (no `setId`), calling the import endpoint until done. Uses `ADMIN_SECRET` from `.env.local`; defaults to `BASE_URL=http://localhost:3000`. For production, set `BASE_URL` to your app URL.

Apply migrations locally:
```bash
supabase db push
```

Security reminder:
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser, client bundles, or public scripts.
- Keep service role keys server-only (`.env.local`, Vercel server env vars, CI secrets).

Local dataset importer:
- Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.
- Run:
```bash
node scripts/import-pokemon-tcg-data-local.mjs
```

Search suggest endpoint (manual check):
- `GET /api/search/suggest?q=pikachu`
- Returns up to 8 canonical cards and up to 5 decks.

## Local environment setup (beginner-friendly)

### 1) Create your local env file

In the project root, copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

> Use `.env.local` for local development. That file is ignored by git and should stay on your machine.

### 2) Fill in the required values (for Next.js, use `.env.local`)

Open `.env.local` and set these values:

```bash
# PSA (server-only)
PSA_ACCESS_TOKEN=your_psa_bearer_token_here
PSA_BASE_URL=https://api.psacard.com

# Supabase server credentials (server-only)
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your_supabase_service_role_key>

# Supabase browser credentials (only needed by browser code)
NEXT_PUBLIC_SUPABASE_URL=https://nbveknrnvcgeyysqrtkl.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5idmVrbnJudmNnZXl5c3FydGtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5ODY4NTMsImV4cCI6MjA4NzU2Mjg1M30.22dNHZBM5WaDmOu8dNSMdpSY61VtA_QH_Ett5xCEDPU

# Existing app secrets (used by other routes)
CRON_SECRET=<any-long-random-string>
ADMIN_SECRET=<any-long-random-string>
NEXT_PUBLIC_SITE_URL=https://popalpha.ai
```

### 3) Where to get each value

Production domain is **https://popalpha.ai**.
For local development, you can either:
- set `NEXT_PUBLIC_SITE_URL=http://localhost:3000`, or
- leave it unset and the app will safely fall back to localhost in development.


If you do not already have these values:
- **PSA_ACCESS_TOKEN**: You must get this from your PSA developer/account portal.
- **SUPABASE_URL**: In your Supabase project dashboard, go to **Project Settings → API → Project URL**.
- **SUPABASE_SERVICE_ROLE_KEY**: In Supabase **Project Settings → API**, copy the **service_role** key. Keep this private (server-only).
- **NEXT_PUBLIC_SUPABASE_ANON_KEY**: In Supabase **Project Settings → API**, copy the **anon public** key.
- **NEXT_PUBLIC_SUPABASE_URL**: Usually same value as `SUPABASE_URL`.

### 4) Restart after env changes

Any time you edit `.env.local`, **restart** your dev server so Next.js picks up the new values.

## Database migration

Run your normal Supabase migration workflow so these SQL files are applied:

- `supabase/migrations/20260226123000_psa_cert_lookup_cache.sql`
- `supabase/migrations/20260226150000_private_sales.sql`

They create:
- `public.psa_cert_cache(cert text primary key, data jsonb, fetched_at timestamptz)`
- `public.psa_cert_lookup_logs(id, cert, cache_hit, status, error_message, created_at)`

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, enter a cert number, and click **Search**.

## API example (curl)

```bash
curl "http://localhost:3000/api/psa/cert?cert=12345678"
```

Expected success JSON shape:

```json
{
  "ok": true,
  "cert": "12345678",
  "cache_hit": false,
  "fetched_at": "2026-02-26T12:30:00.000Z",
  "source": "psa",
  "data": {
    "parsed": {
      "cert_no": "12345678",
      "grade": "10",
      "label": "..."
    },
    "raw": { "...": "..." }
  }
}
```

If required server env vars are missing, expected error shape:

```json
{
  "ok": false,
  "error": "Server configuration error: Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY. Add it to your local env file and restart the dev server."
}
```

Run the same curl twice; second call should typically return `"cache_hit": true` if within 24 hours.


## If you still see a server configuration error

Check these 4 things in order:

1. **File name/location**: your env file must be exactly `.env.local` in the project root (same folder as `package.json`).
2. **Required server vars are present**:
   - `SUPABASE_URL` (required for server routes)
   - `SUPABASE_SERVICE_ROLE_KEY` (required, server-only)
   - `NEXT_PUBLIC_SUPABASE_URL` is optional fallback only
3. **You restarted the dev server** after editing `.env.local` (stop `npm run dev`, then start again).
4. **No quotes or extra spaces** around values (example: `SUPABASE_URL=https://...`, not `SUPABASE_URL="https://..."`).

Tip: server routes prefer `SUPABASE_URL`. If it is missing, code can fall back to `NEXT_PUBLIC_SUPABASE_URL`, but you should still set `SUPABASE_URL` explicitly for reliable local dev.


## Quick feature test checklist

1. **Deep-link search**
   - Open `http://localhost:3000/?cert=12345678`.
   - The page should auto-run lookup for that cert.
   - Click the **Copy link** icon and paste somewhere to confirm URL includes `?cert=...`.

2. **Watchlist (localStorage)**
   - After a cert loads, click the bookmark icon.
   - You should see a toast saying it was saved/removed and a watch status pill in the header.
   - Refresh the page: saved state should persist for that browser profile.

3. **Private Sales tab**
   - Open **Private Sales** tab.
   - Add a sale with date + price (fees/notes optional).
   - Confirm the new sale appears in the list (newest first).
   - API quick checks:
     ```bash
     curl "http://localhost:3000/api/private-sales?cert=12345678"
     ```

4. **Market calculator tab**
   - Open **Market** tab.
   - Enter offer price and fee percentages.
   - Confirm private net, eBay net, difference, and recommendation update.
