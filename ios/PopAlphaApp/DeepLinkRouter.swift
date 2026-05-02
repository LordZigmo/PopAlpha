import Foundation
import OSLog
import SwiftUI

// MARK: - DeepLinkRouter
//
// Receives Universal Links from `.onContinueUserActivity(.browsingWeb)`
// (warm + cold launches both flow through this; SwiftUI bridges the
// AppDelegate `application(_, continue:, restorationHandler:)` callback
// for cold launches).
//
// The router itself doesn't navigate — it parses + classifies the URL
// and stores a `pendingDestination`. View-level code observes that
// state and pushes the right view onto its NavigationStack.
//
// Why a singleton + @Observable: navigation state needs to survive the
// brief window between iOS handing the URL to SwiftUI and the relevant
// tab's NavigationStack actually being on screen (cold launches start
// at the default tab; the deep-linked card may live in a different
// tab). A short-lived singleton holds the pending destination across
// that gap, then clears itself once consumed.
//
// Routing scope (mirrors AASA at app/.well-known/apple-app-site-association/route.ts):
//   /c/<slug>     → .card(slug)
//   /sets/<name>  → .set(name)
//   anything else → ignored (link falls through to Safari, the
//                   correct default behavior per Apple guidelines)

@MainActor
@Observable
final class DeepLinkRouter {
    static let shared = DeepLinkRouter()

    enum Destination: Equatable {
        case card(slug: String)
        case set(name: String)
    }

    var pendingDestination: Destination?

    private init() {}

    /// Called from `.onContinueUserActivity(.browsingWeb)`. Parses the
    /// incoming URL and stashes a destination if it matches a routable
    /// path. Returns `true` if a destination was set, `false` if the
    /// URL didn't match anything we handle.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let host = url.host?.lowercased(), host == "popalpha.ai" else {
            Logger.api.debug("deep link: rejecting non-popalpha host=\(url.host ?? "nil")")
            return false
        }

        // URL.pathComponents starts with "/" then the segments.
        // /c/pikachu-base-set-25 → ["/", "c", "pikachu-base-set-25"]
        let segments = url.pathComponents.filter { $0 != "/" }

        guard let first = segments.first else {
            Logger.api.debug("deep link: no path segments in \(url.absoluteString)")
            return false
        }

        switch first {
        case "c":
            guard segments.count >= 2 else { return false }
            let slug = segments[1]
            Logger.api.debug("deep link → card slug=\(slug)")
            pendingDestination = .card(slug: slug)
            return true

        case "sets":
            guard segments.count >= 2 else { return false }
            let setName = segments[1]
            Logger.api.debug("deep link → set name=\(setName)")
            pendingDestination = .set(name: setName)
            return true

        default:
            Logger.api.debug("deep link: unhandled path first-segment=\(first)")
            return false
        }
    }

    /// Consume the pending destination — view code calls this when it
    /// has actually navigated, so a subsequent re-render doesn't push
    /// the same destination twice.
    func consume() {
        pendingDestination = nil
    }
}
