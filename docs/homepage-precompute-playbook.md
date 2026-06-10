# Homepage Precompute Playbook

**Audience:** Future Claude (or any engineer) touching the homepage / signal-board load path — `/api/homepage`, the `homepage_cache` precompute, its cron, and the iOS Marketplace consumer.

**Last updated:** 2026-06-09 — initial entry, documenting the precompute-blob load-speed fix shipped in PRs #211 / #212 / #213.

---

## Why this file exists

`/api/homepage` backs the first authenticated screen most users hit (iOS `MarketplaceView` "signal board"). Its payload comes from `getHomepageData()` (`lib/data/homepage.ts:1265`) — a heavy, **global** aggregation (movers + market-watch + breakouts) that takes **~8.4s cold**. On a low-traffic function the instance goes cold between hits, so signed-in users saw a 10–20s wait and often had to retry once or twice before the board appeared.

The fix decouples the *read* from the *compute*: a cron precomputes the board into a blob, and `/api/homepage` just serves the newest blob (~0.2s) with a live fallback. This is the **same shape** as the AI-brief precompute (`refresh-ai-brief` cron → `ai_brief_cache` / `public_ai_brief_latest`, see `app/api/cron/refresh-ai-brief/route.ts`). If you add another heavy global endpoint, copy this pattern rather than caching the slow route directly.

## The architecture (one paragraph)

A cron (`app/api/cron/refresh-homepage-cache/route.ts`, schedule `42 * * * *`, deliberately *after* the JP refresh chain) runs `getHomepageData()` once and `INSERT`s the result as a JSONB blob into `public.homepage_cache` (`payload jsonb` with a `jsonb_typeof = 'object'` CHECK, `data_as_of`, `computed_at`; migration `20260608070000_homepage_cache.sql`). `/api/homepage` reads the newest row through the anon/auth view `public_homepage_latest` (a cheap `LIMIT 1`) via `dbPublic().maybeSingle()`, and returns it. It falls back to a **live** `getHomepageData()` only when the blob is missing, errored, or older than `STALE_MAX_AGE_MS` (6h). The response cache is short — `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` — so the edge layers on top of the blob without ever pinning a stale or fallback response for long. The iOS side (`MarketplaceView`) shows a pulsing skeleton and auto-retries the fetch 3× with backoff so a cold/transient miss self-heals instead of forcing the user to pull-to-refresh.

**Result:** `/api/homepage` 8.4s cold → **~0.2s** warm (measured).

## Key files
- **Migration:** `supabase/migrations/20260608070000_homepage_cache.sql` — `homepage_cache` table + `public_homepage_latest` view (granted `anon`, `authenticated`), RLS enabled.
- **Writer cron:** `app/api/cron/refresh-homepage-cache/route.ts` (`requireCron`, `maxDuration = 60`, empty-payload guard, prune > 2 days).
- **Reader route:** `app/api/homepage/route.ts` (`STALE_MAX_AGE_MS`, `CACHE_CONTROL`, live fallback).
- **Source aggregation:** `getHomepageData()` — `lib/data/homepage.ts:1265` (`HomepageData` type at `:125`).
- **iOS consumer:** `ios/PopAlphaApp/MarketplaceView.swift` (skeleton + 3× retry).
- **Registration:** `lib/auth/route-registry.ts` (`CRON_ROUTES`) + `scripts/security-guardrails.config.mjs` (`cronSecretRoute`). Object classification: `homepage_cache` in `RLS_REQUIRED_PUBLIC_TABLES` + `INTERNAL_NO_GRANT_OBJECTS`, `public_homepage_latest` in `PUBLIC_SELECT_ONLY_OBJECTS` + `PUBLIC_VIEW_NAMES`, `homepage_cache_id_seq` in `SEQUENCE_GRANT_CONTRACTS`.

## Non-obvious learnings

### Don't overwrite a good blob with an empty compute
The writer **guards against empty payloads**: if `getHomepageData()` comes back with movers + market_watch + breakouts all empty (a transient upstream hiccup), it **skips the insert** so the last-good blob survives. A precompute cron that blindly writes whatever it computed will periodically nuke the homepage to blank.

### Keep the route cache shorter than the precompute cadence; never pin the fallback
An earlier attempt (#210, closed as a band-aid) just bumped the route's `Cache-Control` TTL. Two ways that bites: (1) an edge TTL **longer than the hourly precompute** serves a blob staler than it needs to be; (2) caching the **live-fallback** response for the full window means one cold miss pins a slow/odd response for everyone until it expires. The shipped design keeps the route cache short (`s-maxage=60`) and lets the *blob* be the durable cache — the fallback is always a fresh live compute, never cached long. If you tune these numbers: keep `s-maxage` ≪ the cron interval, and never raise it to "hide" a flaky precompute.

### Freshness gate, not blind trust
The reader treats a blob older than `STALE_MAX_AGE_MS` (6h) as missing and falls back to live compute. So if the cron silently stops (deploy, quota, schedule drift) users get correct-but-slow data rather than hours-stale data. **Debugging "homepage looks old":** `select computed_at from public_homepage_latest` first — if it's > 6h old the cron stopped (check its recent runs), and the route is already self-healing via fallback (just slow until the cron resumes).

### New public table/view = a two-PR sequence (post-migration window)
`homepage_cache` + `public_homepage_latest` shipped in #211 (migration + route registration); their schema-guardrails **classification** landed in a separate follow-up (#212). The `schema-guardrails` CI job links **live prod**, so you cannot classify an object before its migration has applied — exactly the chicken-and-egg the grader-split tables hit. Full write-up: `docs/grader-split-playbook.md`. Practical cost: `main` CI is red between the two merges — merge the follow-up promptly. (`npm run check:security:static` does *not* catch this locally; only the CI job links prod.)

### iOS: skeleton + bounded auto-retry, re-throwing cancellation
`MarketplaceView` shows a pulsing skeleton (not a bare spinner) and retries the signal fetch **3× with 0.4s/0.8s backoff** (`MarketplaceView.swift` ~`:657`). Critically it **re-throws `CancellationError` / `URLError.cancelled` immediately** rather than retrying them — a SwiftUI `.task` that gets cancelled on view churn must not spend its retry budget on its own cancellation. This is the iOS half of the load-speed fix (#213); the backend precompute is the other half. The two together are what removed both halves of the symptom: the long wait (precompute) and the manual retries (auto-retry).
