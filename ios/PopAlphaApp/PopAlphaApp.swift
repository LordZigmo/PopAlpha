import SwiftUI
import ClerkKit
import Nuke

@main
struct PopAlphaApp: App {
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Clerk.configure(publishableKey: "pk_live_Y2xlcmsucG9wYWxwaGEuYWkk")
        configureImagePipeline()
        configureGlobalAppearance()
    }

    /// Replace the default `AsyncImage` URLSession-backed loader with a
    /// Nuke pipeline tuned for card thumbnails: 200 MB in-memory LRU and
    /// a persistent disk cache so rails don't re-download on every scroll.
    private func configureImagePipeline() {
        ImagePipeline.shared = ImagePipeline {
            $0.dataCache = try? DataCache(name: "ai.popalpha.card-images")
            $0.imageCache = ImageCache(costLimit: 200 * 1024 * 1024)
            $0.isProgressiveDecodingEnabled = false
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(Clerk.shared)
                .preferredColorScheme(.dark)
                .task { await AuthService.shared.restoreSession() }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        if AuthService.shared.isAuthenticated {
                            NotificationService.shared.startPolling()
                            Task { await AuthService.shared.refreshTokenIfNeeded() }
                        }
                    case .background:
                        NotificationService.shared.stopPolling()
                    default:
                        break
                    }
                }
        }
    }

    private func configureGlobalAppearance() {
        // Navigation bar
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = UIColor(PA.Colors.background)
        navAppearance.titleTextAttributes = [.foregroundColor: UIColor(PA.Colors.text)]
        navAppearance.largeTitleTextAttributes = [.foregroundColor: UIColor(PA.Colors.text)]
        navAppearance.shadowColor = .clear

        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance
        UINavigationBar.appearance().compactAppearance = navAppearance
    }
}
