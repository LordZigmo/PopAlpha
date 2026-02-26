# PopAlpha

PopAlpha is a Next.js app for alternative-asset data workflows.

## PSA cert lookup vertical slice

This repo now includes a simple end-to-end cert lookup flow:
- UI page at `/` with a cert search bar.
- Server API at `GET /api/psa/cert?cert=<CERT_NO>`.
- Server-side PSA calls only (token never sent to browser).
- Supabase cache table (`psa_cert_cache`) with 24-hour TTL behavior.
- Supabase lookup logs (`psa_cert_lookup_logs`) for observability.

## Required environment variables

Create a `.env.local` file in the project root and set:

```bash
# PSA (server-only)
PSA_ACCESS_TOKEN=your_psa_bearer_token_here
PSA_BASE_URL=https://api.psacard.com

# Supabase
SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your_supabase_anon_key>
SUPABASE_SERVICE_ROLE_KEY=<your_supabase_service_role_key>

# Existing app secrets (used by other routes)
CRON_SECRET=<any-long-random-string>
ADMIN_SECRET=<any-long-random-string>
```

If you do not already have these values:
- **PSA token**: get it from your PSA developer/account portal.
- **Supabase keys**: open your Supabase project dashboard → Project Settings → API.

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

Example success shape:

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

Run the same curl twice; second call should typically return `"cache_hit": true` if within 24 hours.
