# iOS Gotchas & Footguns

Running log of issues hit while building the PopAlpha iOS app, for future Claude instances (and humans) who are working on `ios/PopAlphaApp/`. Append new entries at the bottom as they come up — most recent first within each section is fine, but keep the structure.

The goal of this document is narrow: capture **non-obvious problems** that cost us time and the fix that worked. Do not pad it with general Swift tips or things that are already obvious from reading the code. If you're tempted to write "remember to call MainActor.run when updating state from async" — don't. That's baseline competence. Write down the things that made us go "wait, what?"

---

## Networking & decoding

### `.convertFromSnakeCase` capitalizes digits-adjacent letters

**Symptom:** iOS decode error `keyNotFound("sparkline7d")` when hitting `/api/homepage`. The JSON clearly contained `"sparkline_7d": [...]` so it looked like the converter should produce `sparkline7d`.

**Root cause:** Swift's `JSONDecoder.KeyDecodingStrategy.convertFromSnakeCase` splits on `_` and calls `String.capitalized` on each non-first component. `"7d".capitalized` returns **`"7D"`** — Swift's `.capitalized` uppercases the first *letter* of the word, even when it's preceded by digits. So `sparkline_7d` converts to `sparkline7D`, not `sparkline7d`.

**Fix:** Name the Swift property to match what the converter produces:
```swift
let sparkline7D: [Double]     // ✅ decodes "sparkline_7d"
let sparkline7d: [Double]     // ❌ keyNotFound
```

**Generalization:** Any JSON field with a letter immediately after a digit is suspect. Mentally run `.capitalized` on each underscore-delimited component before picking a Swift property name:
- `last_24h` → `last24H` (not `last24h`)
- `revenue_2024_q1` → `revenue2024Q1` (not `revenue2024q1`)
- `change_pct_7d` → `changePct7D` (not `changePct7d`)
- `change_pct_24h` → `changePct24H` (not `changePct24h`)

If unsure, test in a Swift REPL:
```swift
import Foundation
struct T: Decodable { let x: Int }  // name the field, try to decode, read the error
let d = JSONDecoder()
d.keyDecodingStrategy = .convertFromSnakeCase
try? d.decode(T.self, from: #"{"some_field_here": 1}"#.data(using: .utf8)!)
```
The `keyNotFound` error tells you exactly what key the decoder was looking for.

**Related:** some of the existing `MetricsRow` / `CardRow` fields in `CardService.swift` sidestep this by not having digit-adjacent letters. If you add a new field like `median_7d` or `low_30d`, do the conversion mentally first.

**Found:** 2026-04-10, while wiring iOS to `/api/homepage` for the signal board.

---

## Xcode project file (`project.pbxproj`)

_(none yet)_

Future entries: add here when you hit weirdness with adding files, targets, or build settings that aren't obvious from just editing the pbxproj.

---

## SwiftUI rendering

### `Spacer` inside an unframed `VStack` collapses to zero and your toast vanishes

**Symptom:** User said "I can barely see it, it's cut off" about a toast I built with:
```swift
VStack {
    Spacer()
    if showResultFlash { detectionToast.transition(...) }
}
.padding(.bottom, 140)
```
intending the toast to sit at the bottom-center of the screen. Instead it rendered in random positions depending on state, sometimes off-screen entirely.

**Root cause:** A `VStack` inside a `ZStack` takes its **intrinsic content size**, not the ZStack's bounds. `Spacer()` by itself has no intrinsic height — it's "greedy" only when its parent has excess space to fill. If the VStack has no `.frame(…, maxHeight: .infinity)`, the Spacer collapses to zero, and the `.padding(.bottom, N)` acts on a zero-height content box centered in the ZStack instead of anchoring to the screen bottom.

**Fix:** Force the container to fill the ZStack before invoking `Spacer`:
```swift
if showResultFlash {
    VStack {
        Spacer()
        detectionToast.padding(.bottom, 140)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)   // ← the critical line
    .allowsHitTesting(false)
    .transition(.opacity.combined(with: .move(edge: .bottom)))
}
```
Also hoist the `if` to the OUTSIDE of the VStack so the whole view mounts/unmounts as one unit — otherwise the SwiftUI transition fights with the layout jump when the conditional flips.

**Generalization:** Any time you use `Spacer` for vertical anchoring inside a `ZStack`, the containing VStack needs an explicit `maxHeight: .infinity` (or `maxWidth` for horizontal). `Spacer` is not magic — it only pushes when there's something to push against.

**Found:** 2026-04-11, while positioning the scanner detection toast at the bottom-center of the screen.

---

### Vision portrait-BL rects → `layerRectConverted` needs landscape-TL sensor coords (NOT a simple y-flip)

**Symptom:** When I first wired the live tracking brackets, they appeared stretched in one axis AND rotated 90° relative to the actual card. The user described it as "felt linked to the gyroscope" — really just "the brackets are in the wrong orientation".

**The trap:** `VNRectangleObservation.boundingBox` is in Vision's portrait-oriented BL space when you pass `.right` to `VNImageRequestHandler(cvPixelBuffer:orientation:)` for a back camera. It's tempting to assume `AVCaptureVideoPreviewLayer.layerRectConverted(fromMetadataOutputRect:)` wants the same portrait-oriented rect with only a y-flip (BL → TL). **It doesn't.**

Per Apple's docs: the method expects its input "normalized (0 to 1) to the device's native video orientation". For the back camera, that's **landscape right** — the sensor's physical orientation, NOT the interface orientation. A y-flip alone passes Vision's portrait coords into a method that interprets them as landscape, producing a 90° mis-rotation plus a width/height swap (which reads as "stretching").

**Correct conversion:** Rotate 90° CCW in coordinate space AND flip y. For a point: `(vx, vy)` in portrait BL → `(1 - vy, 1 - vx)` in landscape TL. For a rect, this swaps width and height and repositions the origin:

```swift
let landscapeRect = CGRect(
    x: 1 - visionBLPortrait.origin.y - visionBLPortrait.height,
    y: 1 - visionBLPortrait.origin.x - visionBLPortrait.width,
    width: visionBLPortrait.height,                 // note the swap
    height: visionBLPortrait.width
)
return previewLayer.layerRectConverted(fromMetadataOutputRect: landscapeRect)
```

**This only works when:**
- Device is in portrait interface orientation
- Back camera (native landscape-right sensor)
- `VNImageRequestHandler` was constructed with `.right` orientation

For other orientations (front camera, landscape interface, upside-down), the transform differs. If you support those, derive the transform from the `CGImagePropertyOrientation` you passed to Vision.

**Reference implementation:** `ios/Sources/Features/Scanner/ScannerView.swift` → `ScannerCameraViewController.installNormalizedRectConverterIfNeeded()`.

**Found:** 2026-04-11. Initially shipped with a y-flip-only conversion; the user caught the misalignment within minutes. The corrected transform above is what actually matches the card on-screen.

---

## Supabase REST client (`SupabaseClient.swift`)

_(none yet)_

Known quirk: the iOS app uses a hand-rolled PostgREST query builder, not the Swift Supabase SDK. Some filter syntaxes (like `in.(a,b,c)`) have specific formatting requirements — check `SupabaseClient.swift` before guessing.

---

## Auth / Clerk integration

_(none yet)_

Known state: `AuthService` has TODO stubs and is not wired to real Clerk flows. The app is freemium — never gate views behind auth.

---

## Build / codesigning / simulator

### Adding a local Swift Package to the Xcode project by editing `project.pbxproj`

**Context:** `ios/Package.swift` defines `PopAlphaCore` (the scanner library with the CoreML model). For a long time it wasn't linked into the app target so `ScannerTabView` was stuck calling a mock. To wire it in without opening Xcode, we edited `ios/PopAlphaApp.xcodeproj/project.pbxproj` directly.

**The six edits needed to add a local SPM dep to a pbxproj** (all in one file, in order):

1. **`PBXBuildFile` entry** (end of that section):
   ```
   EE00000100000000000000F1 /* PopAlphaCore in Frameworks */ = {isa = PBXBuildFile; productRef = EE00000100000000000000A2 /* PopAlphaCore */; };
   ```
2. **Add the build file to the Frameworks build phase's `files` array** (inside the `PBXFrameworksBuildPhase` section — if the phase was empty, you're adding the first entry).
3. **Add `packageProductDependencies` array to the target** (inside the `PBXNativeTarget`, alongside `buildConfigurationList` / `buildPhases`):
   ```
   packageProductDependencies = (
       EE00000100000000000000A2 /* PopAlphaCore */,
   );
   ```
4. **Add `packageReferences` array to the `PBXProject`** (alongside `mainGroup` / `productRefGroup`):
   ```
   packageReferences = (
       EE00000100000000000000A1 /* XCLocalSwiftPackageReference "." */,
   );
   ```
5. **New `XCLocalSwiftPackageReference` section** (add at the end of the objects block, before the closing brace):
   ```
   /* Begin XCLocalSwiftPackageReference section */
       EE00000100000000000000A1 /* XCLocalSwiftPackageReference "." */ = {
           isa = XCLocalSwiftPackageReference;
           relativePath = .;
       };
   /* End XCLocalSwiftPackageReference section */
   ```
6. **New `XCSwiftPackageProductDependency` section** (right after the previous one):
   ```
   /* Begin XCSwiftPackageProductDependency section */
       EE00000100000000000000A2 /* PopAlphaCore */ = {
           isa = XCSwiftPackageProductDependency;
           package = EE00000100000000000000A1 /* XCLocalSwiftPackageReference "." */;
           productName = PopAlphaCore;
       };
   /* End XCSwiftPackageProductDependency section */
   ```

**Key facts:**
- `relativePath = .;` works when `Package.swift` is a sibling of the `.xcodeproj` (both at `ios/` in our case). The path is relative to the xcodeproj's containing directory, **not** the xcodeproj itself.
- Xcode auto-detects the new package on next build — no `pod install`-style step.
- `xcodebuild ... build` with no prior cache generated `PopAlphaCore_PopAlphaCore.bundle/` containing the compiled `.mlmodelc` (from `.mlpackage`), plus auto-generated Swift interface for the model. `.process("Resources")` in `Package.swift` handled the mlpackage correctly — **no `.copy` fallback was needed**.
- The fallback plan (GUI: Xcode → File → Add Package Dependencies → Add Local…) was not needed, but it's the safe escape hatch if a future pbxproj edit corrupts the file.

**Found:** 2026-04-11, wiring the existing `ios/Sources/Features/Scanner/` package into the `PopAlphaApp` target.

---

### `ScannerViewModel` is `@MainActor` + init throws — can't use `@StateObject` directly

`PopAlphaCore.ScannerViewModel` is declared `@MainActor public final class ... { public init(...) throws }`. A SwiftUI `@StateObject private var vm = try ScannerViewModel()` does not compile because the initializer expression can throw.

**Fix:** wrap it in an `@MainActor final class ScannerHost: ObservableObject` that:
- Calls `try ScannerViewModel(useMockData:)` inside its own init, catching errors into `@Published var initError: String?`.
- Exposes the VM as a stored `let viewModel: ScannerViewModel?` (optional — nil when init fails).
- Mirrors the VM's `@Published` state via a Combine `objectWillChange.sink` → `DispatchQueue.main.async` read.

The host then becomes the `@StateObject` for the SwiftUI view, which reads `host.viewModel` to hand to `ScannerView(viewModel:)` and reacts to `host.lastRecognized` via `.onChange`. See `ios/PopAlphaApp/ScannerTabView.swift` for the full pattern.

**Found:** 2026-04-11, same wire-up session.

