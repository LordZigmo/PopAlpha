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
   - User: `requireUser(req)` + `dbPublic()` from `@/lib/db` (switch to `dbUser(jwt)` when RLS is enabled)
   - Admin: `requireAdmin(req)` + `dbAdmin()` from `@/lib/db/admin`
   - Cron/Ingest: `requireCron(req)` + `dbAdmin()` from `@/lib/db/admin`
   - Debug: `requireCron(req)` + `dbAdmin()` from `@/lib/db/admin` (middleware blocks in prod unless `ALLOW_DEBUG_IN_PROD=1`)

## DB Clients

| Client | Import | Key | RLS | Use for |
|---|---|---|---|---|
| `dbAdmin()` | `@/lib/db/admin` | Service role | Bypasses | Cron, admin, debug, ingest, backfill |
| `dbPublic()` | `@/lib/db` | Anon key | Respects | Public routes, user routes, pages, lib helpers |
| `dbUser(jwt)` | `@/lib/db` | Anon key + JWT | Respects | User routes (when RLS is enabled) |

`dbAdmin()` is deliberately isolated in `lib/db/admin.ts` to make service-role usage explicit. A build guard (`scripts/check-dbadmin-imports.mjs`) fails the build if `dbAdmin` appears in public routes, user routes, pages, or components.

## Clerk Integration Checklist

Three swap points to migrate from Supabase Auth to Clerk:

**Swap Point 1** -- `lib/auth/context.ts` `verifyUserJwt()`:
```ts
// Replace body with:
const { userId } = await auth();
return userId ?? null;
```

**Swap Point 2** -- `lib/db/index.ts` `dbUser()`:
```ts
// Update to get Clerk token:
const { getToken } = await auth();
const token = await getToken({ template: "supabase" });
```

**Swap Point 3** -- `middleware.ts`:
For `page-auth` routes, add Clerk's `clerkMiddleware()` redirect.

Everything else stays unchanged: `AuthContext` type, guard functions, route handler code, SQL/RLS policies.

## Security Notes

- All secret comparisons use `safeEqual()` (timing-safe) from `lib/auth/context.ts`
- Debug routes are blocked in production by middleware unless `ALLOW_DEBUG_IN_PROD=1`
- Unknown API routes return 404 (deny-by-default middleware)
- `private_sales` has `owner_id` column; queries are scoped by user
- `holdings` queries are scoped by `user_id`
- RLS policies are created but NOT enabled (enable after confirming all routes use correct client)
