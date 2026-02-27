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
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your_supabase_anon_key>

# Existing app secrets (used by other routes)
CRON_SECRET=<any-long-random-string>
ADMIN_SECRET=<any-long-random-string>
NEXT_PUBLIC_SITE_URL=https://popalpha.app
```

### 3) Where to get each value

Production domain is **https://popalpha.app**.
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
