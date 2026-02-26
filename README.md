# PopAlpha

PopAlpha is a Next.js app for alternative-asset data workflows.

## PSA cert lookup vertical slice

This repo includes a simple end-to-end cert lookup flow:
- UI page at `/` with a cert search bar.
- Server API at `GET /api/psa/cert?cert=<CERT_NO>`.
- Server-side PSA calls only (token never sent to browser).
- Supabase cache table (`psa_cert_cache`) with 24-hour TTL behavior.
- Supabase lookup logs (`psa_cert_lookup_logs`) for observability.

## Local environment setup (beginner-friendly)

### 1) Create your local env file

In the project root, copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

> Use `.env.local` for local development. That file is ignored by git and should stay on your machine.

### 2) Fill in the required values

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
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

### 3) Where to get each value

If you do not already have these values:
- **PSA_ACCESS_TOKEN**: You must get this from your PSA developer/account portal.
- **SUPABASE_URL**: In your Supabase project dashboard, go to **Project Settings → API → Project URL**.
- **SUPABASE_SERVICE_ROLE_KEY**: In Supabase **Project Settings → API**, copy the **service_role** key. Keep this private (server-only).
- **NEXT_PUBLIC_SUPABASE_ANON_KEY**: In Supabase **Project Settings → API**, copy the **anon public** key.
- **NEXT_PUBLIC_SUPABASE_URL**: Usually same value as `SUPABASE_URL`.

### 4) Restart after env changes

Any time you edit `.env.local`, **restart** your dev server so Next.js picks up the new values.

## Database migration

Run your normal Supabase migration workflow so this SQL is applied:

- `supabase/migrations/20260226123000_psa_cert_lookup_cache.sql`

It creates:
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
  "error": "Server configuration error: missing Supabase server environment variables. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
}
```

Run the same curl twice; second call should typically return `"cache_hit": true` if within 24 hours.
