import Foundation
import OSLog
import PostHog

// MARK: - Logger categories
//
// Use these instead of `print(...)` so debug spew is filtered out of the
// system unified log on Release builds (Logger.debug is suppressed unless
// a developer explicitly streams the subsystem). Visible during dev via
// Xcode console / Console.app filtered to subsystem "ai.popalpha.ios".
//
// PopAlphaCore (the Scanner Swift Package) declares its own Logger.scan
// extension because Swift extensions don't cross module boundaries.

extension Logger {
    private static let subsystem = "ai.popalpha.ios"

    static let api          = Logger(subsystem: subsystem, category: "api")
    static let auth         = Logger(subsystem: subsystem, category: "auth")
    static let push         = Logger(subsystem: subsystem, category: "push")
    static let scan         = Logger(subsystem: subsystem, category: "scan")
    static let ui           = Logger(subsystem: subsystem, category: "ui")
}

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
//   • errorTrackingConfig.autoCapture = true — installs PLCrashReporter
//     under the hood. Captures Mach exceptions (EXC_BAD_ACCESS, EXC_CRASH),
//     POSIX signals (SIGSEGV/SIGABRT/SIGBUS), and uncaught NSExceptions
//     as $exception events with level "fatal". Auto-disabled when a
//     debugger is attached, so verification requires Release builds or
//     detaching Xcode. Crashes are persisted to disk and reported on
//     the NEXT app launch — the crashed run itself can't transmit.
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
        // Native crash autocapture via PLCrashReporter. Off by default
        // in the SDK — enabling so production crashes flow into PostHog
        // alongside the canonical Xcode Organizer copy. See file header
        // for what gets captured and how to verify.
        config.errorTrackingConfig.autoCapture = true

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
