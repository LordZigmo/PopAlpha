import Foundation

// MARK: - Feature Flags
//
// Compile-time flags that gate optional product surfaces. Flipping a
// flag and rebuilding ships the change — there's no remote toggle.
//
// `isSocialEnabled` controls all multi-user UGC surfaces: the feed tab,
// the in-app notifications surface, the Activity Visibility setting,
// and the follower/following stats on the user's own profile. While
// `false`, the underlying server routes still work and the moderation
// infrastructure (Report/Block/BlockedUsersView) sits dormant ready
// for when discovery ships. Apple Guideline 1.2 only triggers when
// UGC is actually visible to other users; with this flag off there's
// no UGC surface to police.

enum FeatureFlags {
    static let isSocialEnabled = false
    // Offline-first restored 2026-06-12 while the server embedder
    // migrates to the self-hosted home GPU (the Modal workspace is
    // retired and the replacement isn't online yet) — with this
    // false, EVERY scan rides the dead server path and the scanner
    // is fully down. true = EN scans identify on-device (~300ms);
    // JP scans and offline-failure fallthrough still use the server.
    //
    // The previous state (false, set 2026-05-21) was the accuracy
    // sprint's deliberate "server/model-first until the centrally
    // trained model hits the target first-try rate" — flipping back
    // to false is that thread's call once the home-GPU embedder is
    // live and healthy.
    static let isOfflineScannerEnabled = true
}
