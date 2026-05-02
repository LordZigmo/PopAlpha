# PopAlphaAppTests

Smoke-test bundle for the iOS app. Tests are pure-logic — no network,
no simulator state — so they run in milliseconds and gate every
TestFlight build with a trivial sanity check.

## What's here

- **DeepLinkRouterTests** — URL parsing for Universal Links. Verifies
  host allowlisting, path classification, query-string handling, and
  the `consume()` lifecycle.
- **ScanLanguageTests** — enum sanity (display labels, raw values,
  case count sentinel).
- **MarketCardTests** — `MarketCard.stub(slug:)` factory. Critical
  because both search and deep-link navigation funnel through it.

## One-time Xcode setup

The test source files live in this directory but the Xcode project
hasn't been wired to a test target yet. Adding the target manually
in Xcode is safer than hand-editing `project.pbxproj` and takes ~30
seconds:

1. Open `ios/PopAlphaApp.xcodeproj` in Xcode.
2. **File → New → Target**.
3. iOS tab → **Unit Testing Bundle** → Next.
4. Set:
   - Product Name: `PopAlphaAppTests`
   - Team: same as PopAlphaApp (`SR5AZXDJC3`)
   - Organization Identifier: `ai.popalpha`
   - Language: Swift
   - Project: `PopAlphaApp`
   - Target to be Tested: `PopAlphaApp`
5. Finish — Xcode creates `PopAlphaAppTests/` (with a placeholder
   `.swift` file) and a new scheme.
6. **Delete the placeholder file** Xcode generated (e.g.
   `PopAlphaAppTests.swift` with a single empty test). Then in the
   Project navigator, **right-click `PopAlphaAppTests` group → Add
   Files to "PopAlphaApp"…** and select the three real test files
   already on disk in `ios/PopAlphaAppTests/`:
   - `DeepLinkRouterTests.swift`
   - `ScanLanguageTests.swift`
   - `MarketCardTests.swift`
   - `README.md` (optional — Xcode treats it as a resource)

   In the dialog, make sure **only `PopAlphaAppTests`** is checked
   under "Add to targets". Uncheck `PopAlphaApp`.
7. Build (`⌘B`) — should succeed.
8. Run tests (`⌘U`) — all three test classes should pass.
9. Commit the resulting `project.pbxproj` changes plus the new
   `PopAlphaApp.xcodeproj/xcshareddata/xcschemes/PopAlphaAppTests.xcscheme`
   file. Suggested commit message: `chore(ios): wire PopAlphaAppTests
   target in Xcode project`.

## Why we didn't auto-edit `project.pbxproj`

Adding a new test *target* (vs. a single source file) requires more
than 20 carefully-coordinated entries: PBXNativeTarget,
PBXTargetDependency + PBXContainerItemProxy, an XCConfigurationList
plus its two XCBuildConfiguration entries, BUNDLE_LOADER + TEST_HOST
build settings, references in the project's `targets` array, plus a
shared scheme file. Each entry needs a globally-unique 24-char hex ID
that doesn't collide with the existing 182 entries. The risk of one
incorrect ID corrupting the project is high, and Xcode's "File → New
→ Target" wizard generates all of this correctly in seconds.

## Running tests

After the manual Xcode setup above:

- **In Xcode**: `⌘U` runs the test scheme. Diamonds in the gutter let
  you run individual tests.
- **From the command line**:
  ```bash
  cd ios
  xcodebuild test \
    -project PopAlphaApp.xcodeproj \
    -scheme PopAlphaAppTests \
    -destination 'platform=iOS Simulator,name=iPhone 15'
  ```

## Adding more tests

Create a new file in this directory. Xcode auto-includes it in the
target. Convention: `<TypeUnderTest>Tests.swift` with one `XCTestCase`
subclass per source-of-truth boundary (one for `DeepLinkRouter`, one
for `ScanLanguage`, etc.).

For tests that touch `@MainActor`-isolated state, mark either the test
method or the whole class with `@MainActor` (see `DeepLinkRouterTests`
for the pattern).

For tests that need access to internal symbols, use
`@testable import PopAlphaApp`.

## Future expansion candidates

These would all be high-value smoke tests but need either mocking
infrastructure or careful test data setup:

- API response Codable decode tests (paste a sample `/api/homepage`
  response, assert it decodes into the expected `HomepageDataDTO`).
  Catches contract drift between web and iOS.
- `AnalyticsEvent` raw-value stability (catches accidental rename
  that would break PostHog event continuity).
- `OCRService.extractCardIdentifiers` against fixture images.
- `ScanService.identify` happy-path against a recorded server response.
