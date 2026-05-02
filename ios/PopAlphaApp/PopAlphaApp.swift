import SwiftUI
import ClerkKit
import Nuke

@main
struct PopAlphaApp: App {
    @Environment(\.scenePhase) private var scenePhase
    // Bridge UIKit's AppDelegate callbacks into this SwiftUI @main so
    // APNs callbacks (didRegisterForRemoteNotificationsWithDeviceToken,
    // silent pushes, tap delegates) fire through
    // PushNotificationAppDelegate → PushService.
    @UIApplicationDelegateAdaptor(PushNotificationAppDelegate.self) private var pushDelegate

    init() {
        // PostHog first so any uncaught exceptions thrown during
        // Clerk.configure or image pipeline setup are captured by
        // PostHog's exception autocapture (errorTrackingConfig.autoCapture
        // — see AnalyticsService.swift) rather than lost. Caveat: the
        // crashed run can't transmit; the $exception event flushes on
        // the next launch.
        AnalyticsService.shared.configure()
        Clerk.configure(publishableKey: "pk_live_Y2xlcmsucG9wYWxwaGEuYWkk")
        configureImagePipeline()
        configureGlobalAppearance()
    }

    /// Configure the shared Nuke `ImagePipeline` that backs every
    /// `LazyImage` in the app: 200 MB in-memory LRU for the current
    /// session and a persistent on-disk cache so rails don't
    /// re-download on scroll or across app launches.
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
                .task {
                    // StoreKit 2: start the transaction listener and
                    // refresh entitlements against Apple. Idempotent.
                    await PremiumStore.shared.start()
                    await PremiumStore.shared.loadProducts()
                }
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
