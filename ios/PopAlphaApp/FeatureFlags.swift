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
}
