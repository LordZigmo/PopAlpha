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
