import SwiftUI
import ClerkKit
import Nuke

@main
struct PopAlphaApp: App {
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
            RootView()
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

// Restores the interactive edge-swipe "back" gesture on screens that hide
// the system back button for a custom chevron (CardDetailView, SetDetailView).
// NavigationStack is backed by a UINavigationController whose
// interactivePopGestureRecognizer is disabled the moment the default back
// button is removed; re-attaching its delegate brings the swipe back. The
// `viewControllers.count > 1` guard means it only fires when there's a screen
// to pop, so it never interferes with sheet roots or the tab roots.
extension UINavigationController: UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

// SplashScreenView sits in a ZStack above ContentView so the app's
// startup work (Clerk session restore, StoreKit listener, scanner
// warmup) kicks off at t=0 — the splash just covers the UI for
// ~2.5s while it happens, never blocks it.
private struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSplash = true

    var body: some View {
        ZStack {
            ContentView()
                .environment(Clerk.shared)
                .task { await AuthService.shared.restoreSession() }
                .task {
                    // StoreKit 2: start the transaction listener and
                    // refresh entitlements against Apple. Idempotent.
                    PremiumStore.shared.start()
                    await PremiumStore.shared.loadProducts()
                }
                .task(id: AuthService.shared.currentUserId) {
                    // Pull the user's outgoing block list whenever the
                    // signed-in identity changes (sign-in / sign-out /
                    // account switch). Server-side filtering is
                    // authoritative; this cache lets views hide blocked
                    // content immediately on subsequent renders.
                    if AuthService.shared.isAuthenticated {
                        await BlockedUsersStore.shared.refresh()
                    } else {
                        BlockedUsersStore.shared.clear()
                    }
                }
                .task(priority: .utility) {
                    // Warm scanner cold-start costs eagerly. Cheap OCR
                    // warmup benefits every scan path; when offline
                    // scanning is enabled, the 9s catalog+model load
                    // also happens WHILE the user is browsing
                    // Market/Activity, not when they finally tap
                    // Scanner. ScannerHost was previously
                    // @StateObject inside ScannerTabView, which on
                    // iOS 17+ lazy-instantiates tab bodies — the
                    // prewarm Task in ScannerHost.init() never fired
                    // until the user navigated to the Scanner tab,
                    // defeating the whole purpose. Calling shared
                    // orchestrator + OCR prewarm at App-task time
                    // gates only the heavy offline model work on the
                    // offline-scanner feature flag (server-routed
                    // launches still get local OCR warmed).
                    //
                    // .utility priority so this competes minimally
                    // with the active tab's UI work. ScannerHost
                    // still triggers a redundant .startIfNeeded()
                    // when it inits — idempotent guard makes that a
                    // no-op the second time around.
                    await OfflineScannerWarmup.startIfNeeded()
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

            if showSplash {
                SplashScreenView(isActive: $showSplash)
                    .transition(.opacity.animation(.easeInOut(duration: 0.35)))
                    .zIndex(1)
            }
        }
    }
}
