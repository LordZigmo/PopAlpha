# PopAlpha Release Handoff — 2026-05-28

This is the handoff note for the current release candidate in the canonical checkout:

`/Users/popalpha/Documents/PopAlpha`

Do not use `/Users/popalpha/Documents/GitHub/PopAlpha` unless explicitly comparing or recovering old work.

## Sync Targets

- GitHub remote: `origin https://github.com/LordZigmo/PopAlpha`
- Branch: `main`
- iOS marketing version: `1.0.0`
- iOS build version: `2026.5.24`
- Xcode project metadata source: `ios/PopAlphaApp.xcodeproj/project.pbxproj`

GitHub is only identical to the local checkout after the release candidate commit is pushed. TestFlight is only identical after an archive is built from this checkout and uploaded to App Store Connect.

## Price Trust Standard

- Default headline price is `Market Price`, PopAlpha's conservative market anchor.
- Higher or lower public signals are carried separately as `recent_market_signal_*`.
- Public display states are `ALIGNED`, `SIGNAL_HIGHER`, `SIGNAL_LOWER`, `PUBLIC_ONLY`, `UNDER_REVIEW`, and `NO_RELIABLE_PRICE`.
- Low-dollar positive prices render exactly, including values below `$2`; the old `Abundant card` headline copy is not used for web price display.
- Public copy uses `Market Price`, `Aligned market price`, and `Recent market signal`.
- Public copy must not claim direct TCGplayer, eBay, PriceCharting, or Scrydex sourcing.

## Homepage Standard

- `Market watch` renders before strict mover rails and targets 20 trusted English cards.
- `daily_top_movers` remains strict: no quarantine, confidence, parity, or movement-history relaxation.
- Empty mover rails stay honest; cards are not backfilled into movers unless they pass mover rules.
- Latest build telemetry showed `marketWatchRows: 160`, `marketWatch: 20`, and no missing-change coverage in displayed mover sections.

## Supabase State

The price-trust migrations were pushed live and the daily movers cache was recomputed for 2026-05-28:

- `supabase/migrations/20260528014618_homepage_movers_require_public_price_policy.sql`
- `supabase/migrations/20260528014845_homepage_movers_public_policy_coverage_gate.sql`
- `supabase/migrations/20260528184631_trustworthy_standard_price_display.sql`

Expected live examples:

- `prismatic-evolutions-161-umbreon-ex`: Market Price near `$1,418.70`, recent market signal near `$1,750.50`, state `SIGNAL_HIGHER`.
- `evolving-skies-65-espeon-vmax`: no public headline; under review/quarantined.
- `burning-shadows-41-raichu`: no public headline; under review/quarantined.
- `surging-sparks-238-pikachu-ex`: no reliable public headline.

## Verification

Latest local verification for this release candidate:

- `npm run test:homepage`
- `npm run test:market-truth`
- `node --experimental-strip-types --loader ./scripts/ts-root-loader.mjs tests/displayed-market-price.test.mjs`
- `node scripts/check-migration-function-body.mjs`
- `npm run build`
- `xcodebuild -project ios/PopAlphaApp.xcodeproj -scheme PopAlphaApp -configuration Release -destination generic/platform=iOS build CODE_SIGNING_ALLOWED=NO`

Known intentional build note:

- `[db-env] public_client` warns when Neon/AI DB env vars are present. Pricing/data APIs still use Supabase clients only; leave this guard in place.

Known iOS note:

- Xcode's Release build is the authoritative iOS verification path. Standalone `swift package describe --package-path ios` still reports duplicate inner filenames inside the two CoreML `.mlpackage` bundles, while Xcode compiles and embeds both models successfully.

## Review Notes For Opus

- Check that `Market Price` is the default user-facing headline and recent public movement is contextual, not the main price.
- Check that homepage first render has a populated `Market watch` rail even if strict movers are sparse.
- Check that AI summaries describe the PopAlpha market anchor and recent market signal without implying direct eBay/TCGplayer sourcing.
- Check that quarantined/no-reliable-price cards remain hidden from public headline price surfaces.
- Check that App Store listing copy matches the current Pro model: scanner is free; Pro is market intelligence, collector insights, alerts, and richer workflows.

## Post-Handoff Updates (2026-05-28 — independent Opus 4.8 review)

This RC was independently re-verified end-to-end, and one gap was fixed and merged.

**Build the TestFlight archive from current `main` HEAD** — build number **`2026.5.28`** (marketing version `1.0.0`). `2026.5.28` is still unused (the last uploaded build was `2026.5.24` on May 24), so it uploads fine; bump `CURRENT_PROJECT_VERSION` to today's date if re-archiving on a later day. Deltas since the May 24 build (`bba6f9d`-era): #128 (iOS price copy), #129/#132 (doc sync), #130 (build-number bump off the already-uploaded `2026.5.24`), #131 (P0–P2 robustness), #133/#134 (AI-cron smoke check + CI), #135 (homepage↔detail price parity, low-dollar display, Market Watch rail).

- **iOS price-source copy reframed (PR #128).** The EN `CardDetailView` "Price Source" row and the `MarketplaceView` EN footer named "Scrydex" directly — a violation of the no-direct-sourcing rule above. Both now read `PopAlpha market feeds` (the JP `Yahoo Japan & Snkrdunk` labels were already compliant and are unchanged). Web copy, AI prompts, and the App Store listing were already clean. iOS Release build re-verified green after the change.
- **Live `public_card_metrics` confirms the trust behavior in production.** The view is **per-printing**; the card-detail headline uses the canonical aggregate (`printing_id IS NULL`).
  - `prismatic-evolutions-161-umbreon-ex` canonical row: `market_price = 1418.70`, `recent_market_signal_usd = 1750.50`, `SIGNAL_HIGHER`, confidence HIGH / `POPALPHA_MARKET_CONFIDENT`. The conservative anchor is the headline; the higher public signal is context. ✔
  - `evolving-skies-65-espeon-vmax`, `burning-shadows-41-raichu`, `surging-sparks-238-pikachu-ex` canonical rows are `UNDER_REVIEW` / `NO_RELIABLE_PRICE` with `market_price = null` (headline suppressed). ✔ High `PUBLIC_ONLY` values seen on individual printings (e.g. an espeon-vmax printing at `$7,038.90` from 1 listing / 1 snapshot, confidence LOW) are thin non-default printings, never the card headline.
- **Silent-fallback LLM sites verified remediated.** The two sites `docs/external-api-failure-modes.md` flagged (`lib/personalization/explanation/llm.ts`, `lib/ai/homepage-brief.ts`) now log + propagate `failureReason` and flip `ok:false` / HTTP 500 on full degradation. That doc has been updated.
- **Verifications re-run green:** `test:homepage`, `test:market-truth`, `displayed-market-price`, `check:migration-function-body`, `npm run build` (incl. all 13 security static checks, 123 routes), iOS Release build (`** BUILD SUCCEEDED **`). Build telemetry: `marketWatchRows: 160`, `marketWatch: 20`, `missing: 0`.
- **iOS robustness pass (PR #131).** Pre-release audit fixes: camera permission-denied overlay + Settings link; AVCaptureSession interruption/runtime-error recovery; CardDetailView price-fetch logging; off-main `@Observable` isolation (`signOut`, Push, Notification); missing-key-tolerant homepage DTO decoders; multi-scan mid-submit guard; NaN/Inf formatter guards; logging on silent `try?` sites; reused `CIContext`. Clean Release build, no new warnings.
- **Homepage↔detail price bugs fixed (PR #135).** The detail hero now keeps the canonical `POPALPHA_MARKET_CONFIDENT` anchor (was overwritten by a `PUBLIC_ONLY` per-printing row → homepage/detail mismatch, e.g. Claydol $7 vs $5.27); sub-$2 cards show the exact price + "Low-dollar card" caption (was hidden behind "Abundant", e.g. Cobalion $1.08); iOS now renders the **Market Watch** lead rail (default "Watch" tab) — closing the deferred parity gap. Server: `MAX_DAILY_MOVER_AGE_DAYS` 1→3 so a coverage-gate gap (05-27/05-29 wrote zero daily_top_movers rows) doesn't empty the mover rails.
- **Daily PriceCharting ingestion automated (PR #139).** Root cause of the "only ~139 cards priced within 24h" symptom: the trusted-price rails (`canonical_trusted_raw_prices`) are populated only by the PriceCharting feed, which had been run by hand (last observation `2026-05-27`) and then stopped — so the trustworthy-price view fails closed on stale data even though base `card_metrics` is healthy. Fix: a scheduled cron `/api/cron/import-pricecharting` (daily `0 11 * * *` UTC) now runs the same pipeline the manual CLI did. The CLI orchestration was extracted into `lib/backfill/pricecharting-ingest.ts` so the cron and `scripts/import-pricecharting-products.mjs` share one code path. **Mon–Sat** ticks are lean (upsert products + observations + trusted-price parity RPC) to keep the ~14.8k already-matched cards fresh inside the 300s function ceiling; **Sunday (UTC)** ticks also re-match the full EN catalog to pick up newly released products. `?match=1` / `?match=0` override per-tick for ops.
  - **⚠ Operator prerequisite:** set the `PRICECHARTING_CSV_URL` environment variable in Vercel (the signed CSV download URL from the PriceCharting subscription). Until it is set, the cron returns HTTP 500 (`PRICECHARTING_CSV_URL is not configured`) and the priced-card count stays at its current low. `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are already configured. After the first successful run the "priced within 24h" count should jump from ~139 toward ~14.8k matched cards.
- **Still outstanding:** (1) set `PRICECHARTING_CSV_URL` in Vercel (above) so the trusted-price feed runs; (2) signed TestFlight archive from current `main` HEAD → App Store Connect; (3) on-device, confirm the price parity (Claydol/Cobalion detail == homepage) and a populated Market Watch tab.
