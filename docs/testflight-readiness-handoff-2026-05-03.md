# TestFlight Readiness — Handoff

*Last updated: 2026-05-03*

This document is the exec summary of the multi-session TestFlight-readiness sprint. It exists so the next person (you in 3 weeks, another agent, a future engineer) can pick up without rebuilding context.

For the granular per-item status, see [/Users/popalpha/.claude/plans/i-need-a-punch-foamy-cupcake.md](../../.claude/plans/i-need-a-punch-foamy-cupcake.md). For the migration-drift episode, see [docs/migration-drift-postmortem-2026-05-01.md](./migration-drift-postmortem-2026-05-01.md).

---

## TL;DR

**The app is TestFlight-ready** modulo a 30-second one-time Xcode click-through (M4) and your work in App Store Connect (H4).

The original audit listed one hard blocker (privacy manifest) and ~10 high/medium-priority polish items. All blockers are gone, all medium items are done or scaffolded. Two prod-biting bugs that surfaced during the cleanup were fixed in flight (the SCRYDEX literal in `DISTINCT ON` had been silently breaking targeted price refresh for 3+ weeks; anon `EXECUTE` was revoked on a function the canonical view filter calls, blanking every iOS chart for unauthenticated users).

---

## What landed (commits, in order)

### iOS — TestFlight blockers

| Commit | What |
|---|---|
| `8096702` + `34cbe19` | **B1** Privacy manifest written + added to Xcode target. Without this, App Store rejects the upload outright. |
| `78cf4e3` | **B3** Launch-screen assets committed (was on disk but untracked — clean checkouts rendered black launch). |
| `417d450` | **H1** Six force-unwraps hardened in SupabaseClient (4), CollectorRadarView, SparklineView. The Supabase ones affect every API call path. |

### iOS — UX / accessibility / polish

| Commit | What |
|---|---|
| `c6fc785` | **M5** PostHog `errorTrackingConfig.autoCapture = true`. PLCrashReporter has been a dependency the whole time but the flag was off — PostHog had been receiving zero native-crash events. |
| `ddfb80a` | **M2** 79 `print()` calls → `os.Logger` across 16 files. Categories: `api`, `auth`, `push`, `scan`, `ui`. Filter Console.app via `subsystem:ai.popalpha.ios`. |
| `2c846c4`, `daa5ae6`, `6903cc5` | **M1** VoiceOver coverage in three rounds — round 1 hit highest-frequency components (CardCell, charts, profile rows, scanner toggle), round 2 hit detail/portfolio/signal-board, round 3 hit form sheets and settings. Pattern is documented and consistent across the app. |

### Universal Links pipeline (M3)

| Commit | What |
|---|---|
| `374de9a` | AASA route handler at `app/.well-known/apple-app-site-association/route.ts` + `applinks:popalpha.ai` entitlement + `DeepLinkRouter` singleton + `ContentView.onContinueUserActivity` wiring. |
| `ab7bb65` | `MarketplaceView` consumer — observes `DeepLinkRouter.pendingDestination` via `.onAppear` (cold) + `.onChange` (warm), reuses the existing `searchSelectedCard` → `navigationDestination` pipeline to push CardDetailView. |
| `994aac5` | `ShareLink` button in CardDetailView toolbar. Generates the same `popalpha.ai/c/<slug>` URLs the AASA declares. Doubles as a self-test affordance and a user-visible feature. |
| `7a64e36` | Per-card OpenGraph image at `app/c/[slug]/opengraph-image.tsx`. Replaces the previous behavior where iMessage cropped the raw 63:88 portrait card to fit its 1.91:1 preview canvas. |

### Migration drift cleanup

| Commit | What |
|---|---|
| `4b67e30` | **35-entry drift resolved** — every applied migration now has exactly one local file at the matching timestamp. The two prod-biting bugs (`fix_scrydex_literal_in_distinct_on`, `grant_preferred_canonical_raw_printing`) shipped via CI's `db push` as part of this merge. Full postmortem in `docs/migration-drift-postmortem-2026-05-01.md`. |

### Test scaffolding (M4)

| Commit | What |
|---|---|
| `cc0c178` | `ios/PopAlphaAppTests/` — three test files (DeepLinkRouter, ScanLanguage, MarketCard.stub) covering the most security-relevant pure logic in the app. **Xcode target wiring still needed** (see "Things only you can do" below). |

---

## Things only you can do

These can't be automated safely. Each is a 30-second to 30-minute manual task.

### 1. Wire the test target in Xcode (~30 sec)

Source files for unit tests are in [`ios/PopAlphaAppTests/`](../ios/PopAlphaAppTests/) but Xcode's project file isn't connected to a test bundle yet (auto-editing `project.pbxproj` for a full new target needs 20+ coordinated entries with unique IDs — risk of corrupting the project file). Steps:

1. Open `ios/PopAlphaApp.xcodeproj` in Xcode.
2. **File → New → Target → Unit Testing Bundle**. Product Name `PopAlphaAppTests`, Target to be Tested `PopAlphaApp`.
3. Delete Xcode's auto-generated placeholder `.swift` file.
4. Right-click the new `PopAlphaAppTests` group → Add Files → select the three real test files already on disk → check **only** `PopAlphaAppTests` under "Add to targets" (uncheck PopAlphaApp).
5. ⌘U to verify. All 15 cases should pass.
6. Commit `project.pbxproj` + new `xcshareddata/xcschemes/PopAlphaAppTests.xcscheme`.

After that, `xcodebuild test -scheme PopAlphaAppTests` runs from CLI — hook for CI.

Full README with rationale: [`ios/PopAlphaAppTests/README.md`](../ios/PopAlphaAppTests/README.md).

### 2. App Store Connect — Beta App Review form (H4)

First TestFlight build with external testers triggers a ~24h Beta App Review. Fill in App Store Connect:

- **Demo account**: app is freemium with no auth gate, so reviewers can browse without signing in. State this in "Notes for Reviewer" so they don't get stuck. If any feature is sign-in-only (saving holdings, scanning into a collection), provide a Clerk-backed test account.
- **Contact info**: first/last name, email, phone for App Review questions.
- **What to Test** notes: scanner (English + Japanese toggle), homepage AI brief expand-to-read, push notifications (test push button in NotificationView), card detail / chart / Add to Portfolio, share button.
- **Export Compliance**: already exempt via `ITSAppUsesNonExemptEncryption=false`. Confirm questionnaire matches.
- **Privacy URL**: `https://popalpha.ai/privacy` (verified live).
- **Terms URL**: `https://popalpha.ai/terms` (verified live).

### 3. Real-device smoke test before promoting to external testers

The simulator can't exercise:

- **Universal Links** — disabled in simulators and dev sideloads. Test on a TestFlight install only:
  1. Send yourself `https://popalpha.ai/c/<slug>` via Messages.
  2. Tap the link. App should open directly on that card's detail page.
  3. Sample slugs to test with: `mcdonald-s-collection-2024-1-charizard`, `hidden-fates-32-mew`, `paldean-fates-131-pikachu`.
- **Push notifications** — the test-push button in NotificationView round-trips through APNs.
- **PostHog crash autocapture (M5)** — Release builds only. Trigger a `fatalError` on a debug menu (or wait for organic), reopen the app, check PostHog → Errors for an `$exception` event with `level: "fatal"` within ~5 minutes.
- **Modal scanner inference** — `/api/scan/identify` cold-start latency. Modal can take 15-30s on cold start, which would feel broken to a tester. Either keep it warm with a periodic ping or document the first-scan-may-be-slow caveat.

### 4. Verify the OG image cache

After Vercel ships `7a64e36`:

```bash
curl -i https://popalpha.ai/c/mcdonald-s-collection-2024-1-charizard/opengraph-image
```

Should return `200` with `Content-Type: image/png`. If you re-share a slug that was previously shared, Apple/iMessage caches OG images aggressively (24-48h+) — use a fresh slug to confirm the new image actually rendered correctly.

---

## Known divergences flagged for follow-up

Surfaced during the migration drift cleanup. Each deserves its own focused commit; none are blockers.

### 1. `normalize_scrydex_finish` null/empty token behavior

In `phase2a_variant_classifier_and_columns`. Local design doc says null/empty token → `NULL` (caller must source finish from `card_printings`). Prod runs the function with null/empty token → `'NON_HOLO'`. One of two stories is true: (a) doc is aspirational, prod is doing aggressive guessing on JUSTTCG canonical-form rows that may be miscategorizing reverse-holos, or (b) the team learned NULL was wrong and switched to NON_HOLO without updating docs. Decide which is right and write a follow-up migration that aligns doc with prod.

### 2. `card_profiles_refresh_rpc_tiered` v1→v4 hot-fix iterations

Now visible in git as separate files (`20260429004328` v1, `20260429004756` v2, `20260429005417` v3, `20260429005519` v4). v4's WHERE clause filters `cm.market_price IS NOT NULL` — cards with NULL `market_price` are invisible to the refresh path. Whoever owns the price-coverage investigation should read all four versions and decide whether v4 is the keeper or a v5 is needed.

### 3. `daily_top_movers` and `daily_momentum_rails` out-of-band schema dependencies

Applied SQL relied on `DROP FUNCTION` for signature changes and `DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT` for kind-check expansion that prod got out-of-band. Now restored, but a clean `supabase db reset --linked` against the project would verify replayability across the whole migration set. Worth doing before the next major schema change.

### 4. M3 follow-up: `/sets/<name>` deep-link routing

Card-link routing is wired (commit `ab7bb65`). Sets aren't. Mechanical follow-up: in whichever view owns SetDetailView's NavigationStack, add the same `.onAppear + .onChange(of: DeepLinkRouter.shared.pendingDestination)` triple wired against `case .set(name:)`. Lower priority — set-detail links are a much less common share target than card links.

### 5. Phase 2b/3a/3b cluster sitting in `_pending/`

Three migrations: `phase2b_missing_finish_printings`, `phase3a_stamp_classifier_and_remap`, `phase3b_edition_classifier_and_remap`. They build on already-applied Phase 2a, have idempotency guards, and produce real data movement on first apply (insert ~8.7k card_printings rows, remap printing_ids, etc.). Read each carefully before promoting from `supabase/migrations/_pending/` back into `supabase/migrations/`.

### 6. Scanner cluster in `_pending/`

Three migrations owned by the scanner agent's PR: `scan_events_multicrop_telemetry`, `attention_slugs_for_art_crop`, `attention_slugs_include_labeled`. Promote these in their own scanner-themed PR.

### 7. Dead-code audit (separate workstream)

The user mentioned wanting to clean up code from supplier experiments (Scrydex / JustTCG / PokemonTCG era). Untouched in this sprint. Real audit — provider tables, ingestion routes, retired ML artifacts (CLIP rows now that SigLIP is canonical), iOS surfaces pointing at deprecated endpoints. Deserves its own focused session with a route-by-route review.

---

## Where to find what

| Concern | Location |
|---|---|
| iOS app | `ios/PopAlphaApp/` |
| Xcode project | `ios/PopAlphaApp.xcodeproj/project.pbxproj` |
| Privacy manifest | `ios/PopAlphaApp/PrivacyInfo.xcprivacy` |
| Universal Links AASA | `app/.well-known/apple-app-site-association/route.ts` |
| Universal Links iOS handler | `ios/PopAlphaApp/DeepLinkRouter.swift` + `ContentView.swift` (the `.onContinueUserActivity` modifier) |
| Per-card OG image | `app/c/[slug]/opengraph-image.tsx` |
| Logger extension (main app) | `ios/AnalyticsService.swift` |
| Logger extension (PopAlphaCore) | `ios/Sources/Features/Scanner/Logging.swift` |
| iOS unit tests | `ios/PopAlphaAppTests/` (target wiring pending) |
| Migration source-of-truth | `supabase/migrations/` |
| Held migrations awaiting review | `supabase/migrations/_pending/` |
| CI for migrations | `.github/workflows/supabase-migrations.yml` |
| Drift postmortem | `docs/migration-drift-postmortem-2026-05-01.md` |
| Granular punch list | `~/.claude/plans/i-need-a-punch-foamy-cupcake.md` |

---

## Conventions established this sprint

So future SwiftUI / migration / route work stays consistent.

### Accessibility (M1 pattern)

- Icon-only buttons → `.accessibilityLabel("...")`.
- Decorative SF Symbols next to text → `.accessibilityHidden(true)` on the symbol.
- Multi-element rows that read as one thing → `.accessibilityElement(children: .combine)` or `.accessibilityElement(children: .ignore)` + a custom `.accessibilityLabel`.
- Section titles → `.accessibilityAddTraits(.isHeader)` so VoiceOver rotor jumps cleanly.
- Selectable items in segmented controls → `.accessibilityAddTraits(isSelected ? .isSelected : [])`.

### Logging (M2 pattern)

- Use `Logger.<category>.debug(...)` instead of `print(...)`. Categories: `api`, `auth`, `push`, `scan`, `ui` (declared in `AnalyticsService.swift`).
- Logger extension lives in `AnalyticsService.swift` for the main app and `Sources/Features/Scanner/Logging.swift` for the PopAlphaCore Swift Package (extensions don't cross module boundaries).
- Filter Console.app to `subsystem:ai.popalpha.ios`. Release builds suppress `Logger.debug` at runtime; dev builds surface it.

### Routes (force-dynamic pattern)

- API routes that hit `dbPublic()` should declare `export const dynamic = "force-dynamic"` instead of `revalidate = N`. The Cache-Control header gives equivalent CDN caching, and the build no longer pre-renders the route (so an env-config slip can't take down the deploy).

### Migrations

- `supabase db push --include-all` is the canonical CI command (`.github/workflows/supabase-migrations.yml`). The `--include-all` flag is harmless in steady state and prevents the "out-of-order timestamp" drift error that started the previous mess.
- Don't apply migrations via Supabase Dashboard SQL Editor. If CI is failing, fix CI before applying — silent dashboard applies create the exact problem documented in the drift postmortem.

### pbxproj edits

- Adding a Swift file to the Xcode project requires verified-unique 24-char hex IDs. Grep count mode lies; always use content-grep on the full string before deciding an ID is safe to use. Pattern: pick `EE0000020000000000000Xn` style IDs that don't collide.
- Adding a full new target (test bundle, framework) is much riskier — 20+ entries needed. Use Xcode's wizard for these, not hand-editing.

---

## Quick verification checklist

Things you can verify yourself in <15 minutes:

- [ ] `curl -I https://popalpha.ai/.well-known/apple-app-site-association` returns 200 with `Content-Type: application/json` body containing `SR5AZXDJC3.ai.popalpha.ios`.
- [ ] `curl -I https://popalpha.ai/c/<any-slug>/opengraph-image` returns 200 `image/png`.
- [ ] `npx supabase db push --dry-run --include-all` reports nothing pending.
- [ ] `npx supabase migration list` shows every line with both Local + Remote populated (or only the `_pending/` ones held back intentionally).

Things you need a TestFlight install on a real device for:

- [ ] Tap a `popalpha.ai/c/<slug>` link from Messages → app opens on card detail (not Safari).
- [ ] The share button in CardDetailView opens iOS share sheet → Messages preview shows the full card image with name + set, not a cropped half-card.
- [ ] Test push button in NotificationView → device receives a notification within a few seconds.
- [ ] Force a `fatalError` in a debug menu, reopen app, check PostHog → Errors within 5 minutes for an `$exception` event.
- [ ] Scanner identifies a real card via `/api/scan/identify` and lands on the right detail page.

---

## Known unfixed quirks

These are documented but not addressed:

- **Bell button in CardDetailView toolbar is a no-op placeholder** — `Button {} label: { Image(systemName: "bell") ... }`. Has an `.accessibilityLabel("Notifications")` but tapping does nothing. Either wire it to the notifications screen or remove it; current state is a soft promise the app doesn't keep.
- **OG image manual `images: [...]` in `app/c/[slug]/page.tsx`'s `generateMetadata`** is now redundant with the file-based `opengraph-image.tsx`. Harmless second-place fallback, but cleanup-able as a separate small commit.
- **Force-unwraps in lower-risk surfaces** (`SettingsView.swift:366,454`, `OCRService.swift:28`, `APIClient.swift:126`) — all on stable inputs (URL literals, regex literals, document-dir). Acceptable as-is per the H1 audit.

---

## If something breaks in production

1. **iOS chart blank for anon users** — `grant_preferred_canonical_raw_printing` migration didn't apply or got reverted. Check `supabase_migrations.schema_migrations` for that timestamp.
2. **Targeted price refresh stops advancing `market_price_as_of`** — `fix_scrydex_literal_in_distinct_on` got reverted, or `refresh_card_metrics_for_variants` got redefined elsewhere with the bad literal. Check `pg_proc.prosrc` for that function.
3. **Universal Links stop working** — iOS likely cached an old AASA. In Xcode, toggle the Associated Domains entitlement off / on and reinstall. Or use Apple's diagnostic tool: Settings app → Developer → Universal Links → Diagnostics.
4. **TestFlight upload rejected for missing privacy** — `PrivacyInfo.xcprivacy` got removed from the target. Check `project.pbxproj` for `EE00000100000000000000B1`. The file should appear in the PopAlphaApp group AND the Resources build phase.
