# Auth Model

PopAlpha uses a 4-kind auth model defined in `lib/auth/context.ts`.

## Auth Kinds

| Kind | Who | How | Guard |
|---|---|---|---|
| `public` | Anyone | No credentials | None needed |
| `user` | Logged-in user | Supabase JWT (cookie or Bearer) | `requireUser()` |
| `admin` | Admin tooling | `ADMIN_SECRET` (Bearer or x-admin-secret header) or `ADMIN_IMPORT_TOKEN` | `requireAdmin()` |
| `cron` | Vercel cron / admin | `CRON_SECRET` (Bearer) | `requireCron()` (also accepts admin) |

## Adding a New Route

1. **Pick a classification**: public, user, admin, cron, ingest, or debug
2. **Add to `lib/auth/route-registry.ts`**: Add the route key to the appropriate array
3. **Use the correct guard + db client in the handler**:
   - Public: `dbPublic()` from `@/lib/db` (no guard)
   - User: `requireUser(req)` + `createServerSupabaseUserClient()` from `@/lib/db/user`
   - Admin: `requireAdmin(req)` + `dbAdmin()` from `@/lib/db/admin`
   - Cron/Ingest: `requireCron(req)` + `dbAdmin()` from `@/lib/db/admin`
   - Debug: `requireCron(req)` + `dbAdmin()` from `@/lib/db/admin` (middleware blocks in prod unless `ALLOW_DEBUG_IN_PROD=1`)

## DB Clients

| Client | Import | Key | RLS | Use for |
|---|---|---|---|---|
| `dbAdmin()` | `@/lib/db/admin` | Service role | Bypasses | Cron, admin, debug, ingest, backfill |
| `dbPublic()` | `@/lib/db` | Anon key / publishable key | Respects | Public routes, pages, lib helpers |
| `dbUser(jwt)` | `@/lib/db` | Publishable key + Clerk session token | Respects | Low-level helper for authenticated queries |
| `createServerSupabaseUserClient()` | `@/lib/db/user` | Current Clerk session token | Respects | Authenticated user routes and server actions |

`dbAdmin()` is deliberately isolated in `lib/db/admin.ts` to make service-role usage explicit. A build guard (`scripts/check-dbadmin-imports.mjs`) fails the build if `dbAdmin` appears in public routes, user routes, pages, or components.

## Auth And Security Config Inventory

| Input | Purpose | Intended callers | Checked in | Still needed / overlap |
|---|---|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Enables trusted Clerk identity for user auth and internal-admin operator auth | Browser + server Clerk runtime | `lib/auth/clerk-enabled.ts`, Clerk middleware/runtime entrypoints | Required; distinct from all secret controls |
| `CLERK_RUNTIME_REQUIRED` | Forces Clerk misconfiguration to fail hard in production-like runtime contexts | Server/runtime only | `lib/auth/clerk-enabled.ts` | Useful safety flag; no overlap with auth secrets |
| `INTERNAL_ADMIN_CLERK_USER_IDS` | Primary allowlist for internal-admin operators | `/internal/admin` operators | `lib/auth/internal-admin-session-core.ts` | Required; preferred over email allowlist |
| `INTERNAL_ADMIN_EMAILS` | Fallback/internal convenience allowlist for internal-admin operators | `/internal/admin` operators | `lib/auth/internal-admin-session-core.ts` | Optional; overlaps with Clerk user IDs but is intentionally secondary |
| `INTERNAL_ADMIN_SESSION_SECRET` | Signs the short-lived internal-admin session cookie | `/internal/admin` page + API session verifier | `lib/auth/internal-admin-session-core.ts` | Recommended and should be dedicated; falls back to `ADMIN_SECRET` only if unset |
| `ADMIN_SECRET` | Server-to-server auth for true admin/import routes that are not UI-backed | Manual admin tooling, trusted server calls, import scripts | `lib/auth/context.ts`, `requireAdmin()` routes | Still required; no longer the normal auth path for UI-backed admin flows |
| `ADMIN_IMPORT_TOKEN` | Narrow bearer token for the PokemonTCG import automation surface | `app/api/admin/import/pokemontcg` callers only | `lib/auth/context.ts`, `app/api/admin/import/pokemontcg/route.ts` | Still required; distinct from `ADMIN_SECRET` because it is route-specific and lower-scope |
| `CRON_SECRET` | Cron/internal automation auth bearer | `app/api/cron/**` and debug/repair scripts that intentionally use cron auth | `lib/auth/context.ts`, `requireCron()` routes | Still required; distinct from `ADMIN_SECRET` even though `requireCron()` accepts admin too |
| `ALLOW_DEBUG_IN_PROD` | Explicit production kill-switch override for `app/api/debug/**` | Internal operators only | `proxy.ts` | Still required; distinct route-surface enable flag, not an auth credential |
| `ALLOW_PROVIDER_CANONICAL_IMPORT` | Enables the legacy provider-driven canonical importer and related cron path | Admin/cron importer routes only | `lib/admin/scrydex-canonical-import.ts`, `app/api/cron/sync-canonical/route.ts` | Still required while legacy importer exists; distinct feature gate, not an auth credential |
| `EBAY_VERIFICATION_TOKEN` | eBay challenge-response secret for webhook endpoint setup | eBay deletion notification handshake | `app/api/ebay/deletion-notification/route.ts` | Required for the GET challenge flow; distinct from JWS verification |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | eBay app credentials used to fetch notification verification material | Server-only eBay webhook verifier | `lib/ebay/api.ts` | Required for verified webhook processing; not used for route auth |
| `EBAY_ENV` | Selects eBay production vs sandbox verification endpoints and key namespace | Server-only eBay verifier | `lib/ebay/api.ts`, `lib/ebay/deletion-notification.ts` | Still required; distinct environment selector |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Supabase client config for anon and Clerk-bound user clients | Public routes, authenticated user routes, browser clients | `lib/db/index.ts`, `lib/supabaseClient.ts` | Required; distinct from service-role trust |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only bypass key for `dbAdmin()` and linked verification scripts | Admin/cron/debug/ingest/backfill only | `lib/db/admin.ts`, scripts, server-only helpers | Required; must stay server-only |
| `supabase/config.toml` `[auth.third_party.clerk] enabled = true` | Enables native Clerk -> Supabase third-party auth in local Supabase | Local Supabase runtime | `supabase/config.toml` | Required; distinct from app env because it controls database auth acceptance |

- Role split:
  - `INTERNAL_ADMIN_SESSION_SECRET` signs UI-backed admin sessions.
  - `ADMIN_SECRET` authenticates true server-to-server admin/import routes.
  - `ADMIN_IMPORT_TOKEN` is a one-route import automation credential.
  - `CRON_SECRET` authenticates cron/debug automation.
- Recommended production posture:
  - set a dedicated `INTERNAL_ADMIN_SESSION_SECRET` instead of relying on the `ADMIN_SECRET` fallback
  - prefer Clerk user ID allowlisting over email allowlisting for internal-admin access
  - treat `ALLOW_DEBUG_IN_PROD` and `ALLOW_PROVIDER_CANONICAL_IMPORT` as temporary feature gates, not durable auth controls

## Run Full Security Invariants Locally

`npm run check:security` is now the strict top-level trust check. It no longer treats the linked schema contract as an optional local skip.

Local prerequisites for the linked schema portion:

1. A usable Supabase CLI:
   - preferred: `supabase --version`
   - supported fallback: a cached binary under `~/.npm/_npx/*/node_modules/.bin/supabase`
   - if the CLI is not on `PATH`, set `SUPABASE_CLI_PATH=/absolute/path/to/supabase`
2. A linked workspace with local metadata:
   - `supabase/.temp/project-ref` must exist
   - `supabase/.temp/pooler-url` must exist
   - if either file is missing, run `supabase link --project-ref <project-ref>`
3. A database password in `.env.local`:
   - `SUPABASE_DB_PASSWORD` is the preferred key for linked schema checks
4. Network access to the linked Supabase pooler host:
   - the schema contract uses the linked pooler URL plus `SUPABASE_DB_PASSWORD`
   - CI enforces the same schema contract against the linked project in the `schema-guardrails` job

Recommended local flow:

1. `npm run check:security:doctor`
2. `npm run check:security`
3. `npm run verify:rls` when the change touches live row visibility or ownership semantics

Failure behavior is explicit:

- missing CLI, missing link metadata, or missing DB password -> `npm run check:security:doctor` and `npm run check:security` fail with exact next steps
- missing network access to the linked pooler host -> `npm run check:security:schema:local` fails with the Supabase CLI connection error instead of silently skipping
- linked schema drift -> `npm run check:security` fails and prints the underlying schema-contract diagnostics
- repo-only trust drift -> `npm run check:security:static` still runs without linked DB prerequisites

CI uses the same linked-schema flow with `supabase/setup-cli@v1` pinned to CLI `2.82.0`, so local/CI drift is easier to reason about.

## Privileged Entrypoints

High-trust entrypoints outside `app/api/**` and `scripts/**` now have an explicit contract in `scripts/security-guardrails.config.mjs`.

- Internal admin UI entrypoints:
  - every `page.tsx`, `layout.tsx`, and `actions.ts` under `app/internal/admin/**`
  - trust model: trusted Clerk operator + internal admin allowlist + short-lived HttpOnly internal-admin cookie
- Auth/middleware glue:
  - `proxy.ts`
  - `lib/auth/clerk-enabled.ts`
  - `lib/auth/context.ts`
  - `lib/auth/require.ts`
  - `lib/auth/internal-admin-session-core.ts`
  - `lib/auth/internal-admin-session.ts`
  - `lib/auth/route-registry.ts`
  - trust model: explicit route classification, secret-based admin/cron resolution where justified, and Clerk-backed internal-admin revalidation
- Privileged package-script wrappers:
  - top-level security wrappers: `check:security`, `check:security:doctor`, `check:security:invariants`, `check:security:schema`, `check:security:schema:local`, `verify:rls`, `verify:rls:linked`
  - operational wrappers: `ebay:deletion-setup`, `env:pull-safe`, `sets:backfill-summaries`, `import:pokemontcg-all`, `import:scrydex-all`, `import:scrydex-missing-printings`, `report:set-efficiency`, `justtcg:repair-sweep`, `justtcg:backfill-live`, `watch:unknown-finishes`, `ai:refresh-embeddings`
  - trust model: thin wrappers around classified privileged scripts only; command drift is checked in CI
- Secret-bearing GitHub workflows:
  - `.github/workflows/ci.yml`
  - `.github/workflows/psa-ingest-cron.yml`
  - `.github/workflows/supabase-migrations.yml`
  - trust model: explicit workflow contracts, expected secrets, and pinned Supabase CLI version where schema authority is involved

What never to do:

- hardcode secrets or tokens in package scripts, PowerShell helpers, workflows, or local bootstrap files
- add a new internal admin page/action without classifying it in the privileged-entrypoint contract
- add a new secret-bearing workflow without an explicit contract entry
- point a privileged package script at the wrong operational target; the contract now checks the expected command fragments directly
- reintroduce hidden route-to-route bridges or freeform operator identifiers as audit truth

## Internal Admin Pages

PopAlpha's internal admin pages use a separate, intentionally narrow pattern:

- `/internal/admin/sign-in` requires an authenticated Clerk operator plus an explicit internal admin allowlist, then issues a short-lived, signed, HttpOnly session cookie scoped to `/internal/admin`.
- Protected internal pages call `requireInternalAdminSession()` server-side before rendering anything sensitive.
- Internal admin pages must stay server-rendered. They should not use client-side unauthenticated fetch patterns or import `dbAdmin()` directly.
- Authorization is explicit and revocable through `INTERNAL_ADMIN_CLERK_USER_IDS` and/or `INTERNAL_ADMIN_EMAILS`. Clerk user IDs are the preferred source of truth because audit events and review annotations use the canonical actor format `clerk:<clerk_user_id>`.
- The internal eBay review JSON routes now use the same trusted internal admin session model as the page layer. Server-only helpers forward the current request cookies to those routes, and the routes re-validate the short-lived internal admin cookie plus the current Clerk-backed allowlist on every call.
- Audit actor identity for internal review routes comes from the verified internal admin session as canonical `clerk:<userId>`. Caller-provided headers are not the source of truth for review-route audit attribution.
- `ADMIN_SECRET` is no longer the normal auth path for `/api/admin/ebay-deletion-tasks` or `/api/admin/ebay-deletion-tasks/[id]`. It remains scoped to the true server-to-server admin/import surfaces that still use `requireAdmin()`.
- The internal admin session is re-validated against the current Clerk user and allowlist on every protected request, so removing an operator from the allowlist revokes access without waiting for cookie expiry.
- The build guard `scripts/check-internal-admin-pages.mjs` fails if files under `app/internal/admin` drift into `use client`, `dbAdmin()`, or direct fetches outside the approved admin review route surface.

## Internal Route Trust Models

Use one of these explicit trust models for every `app/api/admin/**`, `app/api/cron/**`, and `app/api/debug/**` route:

- `internal_admin_session`
  - for operator-driven routes used by `/internal/admin` pages
  - route auth comes from `requireInternalAdminApiAccess(req)`
  - audit actor identity must come from the verified internal admin session as `clerk:<userId>`
- `admin_secret`
  - for true server-to-server admin/import tooling that is not UI-backed
  - route auth comes from `requireAdmin(req)`
- `admin_import_token`
  - for narrow import automation surfaces that use `ADMIN_IMPORT_TOKEN`
  - these are not operator-session routes and must stay non-UI
- `cron_secret`
  - for cron/internal automation routes guarded by `requireCron(req)`
- `debug_cron_guard`
  - for internal debug, repair, and diagnostic routes guarded by `requireCron(req)`
  - these are not UI-backed and stay blocked in production unless `ALLOW_DEBUG_IN_PROD=1`
- `debug_internal_admin_session`
  - reserved for any future UI-backed debug route that must sit behind the trusted internal-admin session
- `debug_deprecated`
  - for explicit shutdown/retired debug routes while they are being removed

Machine-enforced route inventory lives in `scripts/security-guardrails.config.mjs` under `INTERNAL_ROUTE_TRUST_CONTRACTS` and `DEBUG_ROUTE_TRUST_CONTRACTS`.

When adding a new internal/admin/debug route:

1. If the route is used by `/internal/admin` UI, use `requireInternalAdminApiAccess(req)` and classify it as `internal_admin_session`.
2. If the route is manual server-to-server admin/import tooling, use `requireAdmin(req)` or the existing import-token pattern and classify it explicitly.
3. If the route is cron/internal automation, use `requireCron(req)` and classify it explicitly.
4. If the route is debug/diagnostic/repair tooling, prefer `requireCron(req)` and classify it in `DEBUG_ROUTE_TRUST_CONTRACTS`.
5. Add the route key to `lib/auth/route-registry.ts`.
6. Add the route trust entry to the correct contract map.
7. Run `npm run check:internal-route-trust` and `npm run check:debug-route-trust`.

## Route Vs Module

- Keep a route when it is a real network boundary: operator UI, cron invocation, manual admin tooling, or an external script target.
- Do not reuse one internal route from another route just to share logic. Extract the shared server work into a module under `lib/` and let each route keep only its own auth, input parsing, and response shaping.
- The Scrydex canonical importer now follows that pattern: `app/api/admin/import/scrydex-canonical/route.ts`, `app/api/admin/import/pokemontcg-canonical/route.ts`, `app/api/admin/import/pokemontcg/route.ts`, and `app/api/cron/sync-canonical/route.ts` all call `lib/admin/scrydex-canonical-import.ts` instead of treating another route as an internal API.

## Clerk Integration

PopAlpha uses Supabase's native Clerk third-party auth integration. The database trusts the Clerk session token directly, and user-owned policies key off Clerk claims from `auth.jwt()`, typically `auth.jwt()->>'sub'`.

- Local Supabase config must keep `[auth.third_party.clerk]` enabled.
- User routes should call `createServerSupabaseUserClient()` after `requireUser()` or `requireOnboarded()`.
- `dbUser(jwt)` uses Supabase's `accessToken` client option, not a custom `Authorization` header hack.
- Do not use Clerk JWT templates for Supabase in active code or docs.

Example:

```ts
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const db = await createServerSupabaseUserClient();
  const { data, error } = await db.from("holdings").select("*");
  // ...
}
```

## Policy Rules

- User-owned rows must key ownership to Clerk IDs stored as text.
- Prefer `owner_clerk_id text` for owned rows and `clerk_user_id text` for identity rows.
- Policies should use `auth.jwt()->>'sub'`, not `auth.uid()`, unless a table is genuinely owned by Supabase Auth UUIDs.
- `UPDATE` flows usually need both `SELECT` visibility and `WITH CHECK` ownership validation.
- Tighten grants alongside RLS; do not depend on RLS alone while leaving broad table privileges in place.

## Security Notes

- All secret comparisons use `safeEqual()` (timing-safe) from `lib/auth/context.ts`
- Debug routes are blocked in production by middleware unless `ALLOW_DEBUG_IN_PROD=1`
- Unknown API routes return 404 (deny-by-default middleware)
- `dbAdmin()` is server-only and should never be the primary authorization mechanism for user-owned data
- Public/profile/read-model views should expose the minimum safe contract and use `security_invoker` only when they truly need to obey underlying RLS
