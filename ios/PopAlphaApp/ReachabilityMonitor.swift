import Foundation
import Network
import SwiftUI

// MARK: - Reachability Monitor
//
// Apple Guideline 2.1: a reviewer's airplane-mode test must not be met
// with infinite spinners. This singleton wraps NWPathMonitor and feeds
// `isOnline` into the OfflineBanner overlay so any view that fails to
// fetch has a top-level explanation for *why* it failed (and any view
// that would have shown a generic spinner gets the banner instead).
//
// The monitor stays running for the app's lifetime — it's cheap and
// pathUpdateHandler fires only on transitions, not continuously.

@MainActor
final class ReachabilityMonitor: ObservableObject {
    static let shared = ReachabilityMonitor()

    @Published private(set) var isOnline: Bool = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ai.popalpha.reachability", qos: .utility)

    private init() {
        // Default to true so the banner doesn't flash before the first
        // path update arrives. NWPathMonitor's first update is delivered
        // ~50-200ms after start; assuming online avoids a startup blink.
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.isOnline != online {
                    self.isOnline = online
                }
            }
        }
        monitor.start(queue: queue)
    }
}

// MARK: - Offline Banner

/// Slim banner that overlays the top of the root view when network is
/// unavailable. Auto-hides on reconnect. Informational only — taps fall
/// through to whatever's underneath (each view handles its own retry).
struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 13, weight: .semibold))
            Text("You're offline")
                .font(.system(size: 13, weight: .semibold))
                .accessibilityLabel("You're offline. Some features may not be available.")
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(PA.Colors.negative)
        .allowsHitTesting(false)
    }
}

// MARK: - View Modifier
//
// Attached to the app's root TabView in ContentView. Uses
// `safeAreaInset(edge: .top)` so the banner pushes the rest of the
// content down rather than overlapping toolbars / nav titles —
// jankier visually than an overlay but functionally honest about
// the available screen real estate while offline.

private struct OfflineBannerModifier: ViewModifier {
    @ObservedObject private var reachability = ReachabilityMonitor.shared

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                if !reachability.isOnline {
                    OfflineBanner()
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.22), value: reachability.isOnline)
    }
}

extension View {
    /// Adds the global "you're offline" banner to a view. Apply once at
    /// the app root; multiple applications would stack banners.
    func offlineBanner() -> some View {
        modifier(OfflineBannerModifier())
    }
}
