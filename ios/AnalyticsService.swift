import Foundation
import PostHog

// MARK: - Analytics Service (PostHog)
//
// Thin, typed wrapper around PostHogSDK that:
//
//   • Configures the SDK once at app launch (configure())
//   • Uses an AnalyticsEvent enum so event names can't be typo'd and
//     are grep-able across the codebase
//   • Uses the Clerk user id as distinct_id so iOS events attribute to
//     the same PostHog person as the user's web sessions (enables
//     cross-platform funnels)
//
// Configuration notes:
//   • captureApplicationLifecycleEvents = true — PostHog auto-captures
//     $app_opened, $app_backgrounded, $app_installed, and $app_updated.
//     You don't need to fire these manually.
//   • captureScreenViews = false — SwiftUI doesn't use UIViewControllers
//     the traditional way, so SDK autocapture is unreliable. Fire
//     AnalyticsService.shared.capture(.screenViewed, ...) from .onAppear
//     on the main tabs when you want screen-level coverage.
//   • sessionReplay = false — disabled for now. Enable later via a flag
//     once we've decided on privacy masking for card/portfolio views.
//
// The phc_* project API key is a public, client-embeddable token (it's
// rate-limited per IP, not secret) — safe to hardcode just like the
// Clerk publishable key in PopAlphaApp.swift.

enum AnalyticsEvent: String {
    // Auth lifecycle
    case userSignedIn = "user_signed_in"
    case userSignedOut = "user_signed_out"

    // Core flows
    case cardScanned = "card_scanned"
    case cardViewed = "card_viewed"
    case searchPerformed = "search_performed"
    case holdingAdded = "holding_added"
    case holdingRemoved = "holding_removed"
    case watchlistAdded = "watchlist_added"
    case watchlistRemoved = "watchlist_removed"

    // Push / engagement
    case pushPermissionPrompted = "push_permission_prompted"
    case pushPermissionResponse = "push_permission_response"
    case pushNotificationOpened = "push_notification_opened"

    // Navigation
    case screenViewed = "screen_viewed"
}

final class AnalyticsService {
    static let shared = AnalyticsService()

    private var configured = false

    private init() {}

    // MARK: - Setup

    /// Call once from PopAlphaApp.init() before any capture/identify.
    /// Idempotent — safe to invoke repeatedly.
    func configure() {
        guard !configured else { return }
        configured = true

        let config = PostHogConfig(
            apiKey: "phc_sCBhLBr4jbxrgXkWXSdUCEz2J9SVva9u7kqa96LU4DBu",
            host: "https://us.i.posthog.com"
        )
        // Auto-capture $app_opened / $app_backgrounded / $app_installed /
        // $app_updated — no need to fire these manually.
        config.captureApplicationLifecycleEvents = true
        // SwiftUI + UIKit screen autocapture is unreliable; we send
        // screen_viewed manually from tab roots.
        config.captureScreenViews = false
        // Session replay is a paid-tier-sensitive feature. Leave off
        // for launch; turn on after a privacy-masking audit.
        config.sessionReplay = false

        PostHogSDK.shared.setup(config)
    }

    // MARK: - Identity

    /// Attach subsequent events to a specific user. Pass the Clerk user
    /// id so events land on the same PostHog person as the user's web
    /// sessions. Additional properties (email, name) are set on the
    /// person profile — pass only what the user has consented to share.
    func identify(userId: String, email: String? = nil, firstName: String? = nil) {
        var props: [String: Any] = [:]
        if let email { props["email"] = email }
        if let firstName { props["first_name"] = firstName }
        PostHogSDK.shared.identify(userId, userProperties: props)
    }

    /// Call on sign-out so subsequent events are attributed to a fresh
    /// anonymous distinct_id rather than leaking onto the previous user.
    func reset() {
        PostHogSDK.shared.reset()
    }

    // MARK: - Capture

    /// Fire a typed event. Properties are optional — omit when the
    /// event carries no meaningful dimensions.
    func capture(_ event: AnalyticsEvent, properties: [String: Any]? = nil) {
        PostHogSDK.shared.capture(event.rawValue, properties: properties)
    }

    /// Fire a custom event by string. Prefer the typed `capture(_:)`
    /// overload above — this exists only for cases where the event
    /// name is genuinely dynamic (e.g. feature flag experiments).
    func captureRaw(_ eventName: String, properties: [String: Any]? = nil) {
        PostHogSDK.shared.capture(eventName, properties: properties)
    }
}
