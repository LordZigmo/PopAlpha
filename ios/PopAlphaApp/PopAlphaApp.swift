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
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    // Re-assert the delegate after each appearance. On iOS 26 SwiftUI's
    // NavigationStack can reset interactivePopGestureRecognizer.delegate across
    // pushes, which silently dropped the swipe-back gesture even though
    // viewDidLoad had set it once.
    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }

    // This delegate is only attached to interactivePopGestureRecognizer, so
    // allowing simultaneous recognition lets the left-edge pan coexist with the
    // content's scroll/drag gestures instead of being swallowed on scroll-heavy
    // detail screens — the other half of why the swipe didn't engage.
    public func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

// SplashScreenView sits in a ZStack above ContentView so the app's
// startup work (Clerk session restore, StoreKit listener, scanner
// warmup) kicks off at t=0 — the splash just covers the UI for
// ~2.5s while it happens, never blocks it.
private struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSplash = true
    /// Observed so a cold-launch restore can re-fire when connectivity returns.
    /// A launch that stays offline past the background-retry window would
    /// otherwise leave a valid Keychain session signed-out until the process is
    /// killed (Codex P2 on #313).
    @ObservedObject private var reachability = ReachabilityMonitor.shared
    /// Same stored appearance ContentView applies (ContentView:115) —
    /// but SplashScreenView sits ABOVE ContentView in this ZStack,
    /// outside that modifier's subtree, so without applying it here
    /// the splash follows the SYSTEM scheme even when the user chose
    /// light/dark in-app. Applied on the ZStack so the splash and the
    /// app resolve the same scheme from frame one. (The static
    /// UILaunchScreen frame is rendered by iOS before the process
    /// runs and can only follow the system scheme — its assets are
    /// appearance-aware, which covers the dominant follow-system
    /// case.)
    @AppStorage(AppearanceMode.storageKey) private var appearanceRaw: String = AppearanceMode.system.rawValue
    private var appearance: AppearanceMode {
        AppearanceMode(rawValue: appearanceRaw) ?? .system
    }

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
                    // defeating the whole purpose. Warming the cheap
                    // local OCR at App-task time absorbs that cost up
                    // front for every launch.
                    //
                    // startIfNeeded() is now CHEAP-ONLY (local OCR). The
                    // heavy offline model load is intentionally NOT
                    // warmed here — at launch it starved camera bring-up
                    // and blacked out the scanner preview. It warms
                    // instead from ScannerHost's first-frame transition,
                    // once the camera is live. .utility priority so this
                    // competes minimally with the active tab's UI work.
                    await OfflineScannerWarmup.startIfNeeded()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        if AuthService.shared.isAuthenticated {
                            NotificationService.shared.startPolling()
                            Task { await AuthService.shared.refreshTokenIfNeeded() }
                        } else {
                            // Re-attempt restore on foreground so a valid cached
                            // session that couldn't mint while offline recovers
                            // without a process restart. Guarded so it never
                            // resurrects an explicit sign-out.
                            Task { await AuthService.shared.recoverSessionIfNeeded() }
                        }
                    case .background:
                        NotificationService.shared.stopPolling()
                    default:
                        break
                    }
                }
                .onChange(of: reachability.isOnline) { wasOnline, isOnline in
                    // Connectivity just returned → recover a valid session that
                    // couldn't mint a token while the launch was offline.
                    // recoverSessionIfNeeded() is a no-op after an explicit
                    // sign-out or when already signed in.
                    guard !wasOnline, isOnline else { return }
                    Task { await AuthService.shared.recoverSessionIfNeeded() }
                }

            if showSplash {
                SplashScreenView(isActive: $showSplash)
                    .transition(.opacity.animation(.easeInOut(duration: 0.35)))
                    .zIndex(1)
            }
        }
        .preferredColorScheme(appearance.colorScheme)
    }
}
