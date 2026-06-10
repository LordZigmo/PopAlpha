import SwiftUI
import NukeUI
import StoreKit

struct ContentView: View {
    // Default to Scanner tab when launched with -runOfflineSmoke or
    // -debugOfflineIdentifier so the scanner's onAppear fires and the
    // smoke test runs without needing a manual tab switch. DEBUG-only,
    // no production cost.
    @State private var selectedTab: AppTab = {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-runOfflineSmoke") || args.contains("-debugOfflineIdentifier") {
            return .scanner
        }
        #endif
        return .market
    }()
    // Observed so the root-level sign-in error alert fires whenever
    // AuthService.shared.signInError becomes non-nil, no matter which
    // screen triggered the sign-in.
    private var auth: AuthService { AuthService.shared }

    // User-selectable color-scheme override. Default `.system` honours
    // iOS Settings → Display & Brightness; the picker in Settings →
    // Appearance lets users pin Light or Dark within PopAlpha.
    @AppStorage(AppearanceMode.storageKey) private var appearanceRaw: String = AppearanceMode.system.rawValue
    private var appearance: AppearanceMode {
        AppearanceMode(rawValue: appearanceRaw) ?? .system
    }

    // Trial re-engagement plumbing. Auto-presents the paywall once
    // when we observe a lapsed subscriber (`!isPro &&
    // !isEligibleForTrial`) — they've used the trial and aren't
    // currently paid, so the hero copy welcomes them back rather
    // than pitching cold. Persistent dedupe via UserDefaults; flag
    // resets the moment they re-upgrade so a second lapse can
    // trigger again.
    @StateObject private var premiumStore = PremiumStore.shared
    @StateObject private var premiumGate = PremiumGate.shared
    @State private var showReengagementPaywall = false
    @State private var showTrialExpiringPaywall = false

    // Enjoyment gate → review/feedback flow (the X-style pattern: every
    // surface is native). Fires once, on the 3rd cold launch — Apple's
    // HIG says ask only after demonstrated engagement, the system
    // prompt is capped at 3 shows/365d, and sentiment gates measurably
    // convert best around the 3rd session — then routes "Yes" to the
    // StoreKit system review prompt and "Not really" to a native
    // text-field alert whose submission lands in PostHog.
    @Environment(\.requestReview) private var requestReview
    @State private var showEnjoymentGate = false
    @State private var showFeedbackAlert = false
    @State private var feedbackText = ""
    private static let appOpenCountKey = "ai.popalpha.review.appOpenCount"
    private static let enjoymentGateShownKey = "ai.popalpha.review.gateShown"
    private static let enjoymentGateMinOpens = 3

    private static let reengagementShownKey = "ai.popalpha.premium.reengagement.shown"
    /// Per-trial dedupe for the trial-expiring auto-paywall. Keyed by
    /// trial expiration date (epoch seconds) so a future trial — if
    /// Apple ever grants the user another one — gets its own prompt.
    private static let trialExpiringShownKeyPrefix = "ai.popalpha.premium.trialExpiring.shown."

    init() {
        configureTabBarAppearance()
    }

    var body: some View {
        TabView(selection: Binding(
            get: { selectedTab },
            set: { newValue in
                if newValue != selectedTab { PAHaptics.selection() }
                selectedTab = newValue
            }
        )) {
            // Bind selectedTab into MarketplaceView so the new
            // MarketHeroCard / MarketScanStrip can switch to the Scan
            // tab without going through NotificationCenter or a singleton.
            MarketplaceView(selectedTab: $selectedTab)
                .tabItem {
                    Label("Market", systemImage: "chart.line.uptrend.xyaxis")
                }
                .tag(AppTab.market)

            SearchTabView()
                .tabItem {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .tag(AppTab.search)

            ScannerTabView()
                .tabItem {
                    Label("Scan", systemImage: "viewfinder")
                }
                .tag(AppTab.scanner)

            PortfolioView()
                .tabItem {
                    Label("Portfolio", systemImage: "rectangle.stack")
                }
                .tag(AppTab.portfolio)

            ProfileTabView()
                .tabItem {
                    Label("Profile", systemImage: "person.crop.circle")
                }
                .tag(AppTab.profile)
        }
        .tint(PA.Colors.accent)
        // App Review compliance modifiers — these were applied on PR #30
        // and inadvertently dropped by the SearchTabView extraction
        // commit (a782f51). Restored here so light/dark, offline banner,
        // and the push permission soft-prompt all work at the root.
        .preferredColorScheme(appearance.colorScheme)
        .offlineBanner()
        .sheet(
            isPresented: Binding(
                get: { PushService.shared.showSoftPrompt },
                set: { newValue in PushService.shared.showSoftPrompt = newValue }
            )
        ) {
            PushPermissionPromptSheet()
        }
        .sheet(
            isPresented: Binding(
                get: { AuthService.shared.showSignInSheet },
                set: { newValue in AuthService.shared.showSignInSheet = newValue }
            )
        ) {
            // Generic chooser opened by `AuthService.shared.signIn()` —
            // the shortcut "Sign In" buttons scattered through the app
            // (Settings, Watchlist empty, Portfolio empty, alerts, etc.)
            // all flow through this so email is reachable everywhere.
            SignInSheet(startingPhase: .chooser)
        }
        .alert(
            "Sign-in failed",
            isPresented: Binding(
                get: { auth.signInError != nil },
                set: { if !$0 { auth.clearSignInError() } }
            ),
            actions: {
                Button("OK", role: .cancel) { auth.clearSignInError() }
            },
            message: {
                Text(auth.signInError ?? "Something went wrong. Please try again.")
            }
        )
        // Universal Links — Apple's CDN routes taps on popalpha.ai links
        // here when our AASA at /.well-known/apple-app-site-association
        // matches. SwiftUI bridges both warm-launch and cold-launch
        // continuations through this modifier on the root view.
        // DeepLinkRouter parses the URL and stashes a destination;
        // tab-level views observe pendingDestination to navigate.
        //
        // Not also wiring `.onOpenURL` here — Clerk's OAuth callback
        // (ai.popalpha.ios://callback) is consumed inside ClerkKit via
        // ASWebAuthenticationSession and shouldn't be intercepted by
        // a top-level handler.
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            let didRoute = DeepLinkRouter.shared.handle(url: url)
            if didRoute, case .card = DeepLinkRouter.shared.pendingDestination {
                // Card destinations live in the Market tab's stack.
                selectedTab = .market
            }
        }
        // Trial re-engagement — auto-presents once for lapsed
        // subscribers. Conditions evaluate after products load (so
        // isEligibleForTrial is accurate) and re-evaluate when any
        // input changes.
        .sheet(isPresented: $showReengagementPaywall) {
            PaywallView(context: .reengagement, surface: "reengagement_auto")
        }
        // Trial-expiring auto-paywall — presents once when the user is
        // inside the final 48h of their free trial. Pairs with the
        // server-driven push notification 24h before expiry: the push
        // brings them back into the app, this is the catch.
        .sheet(isPresented: $showTrialExpiringPaywall) {
            PaywallView(context: .trialExpiring, surface: "trial_expiring_warning")
        }
        // Enjoyment gate — both alerts are native (system alert + system
        // text-field alert), and the "Yes" path hands off to StoreKit's
        // system review sheet, so the whole flow reads as Apple UI.
        .alert("Enjoying PopAlpha?", isPresented: $showEnjoymentGate) {
            Button("No") {
                AnalyticsService.shared.capture(.reviewGateAnswered, properties: ["answer": "no"])
                // Brief gap so the gate alert finishes dismissing before
                // the feedback alert presents — back-to-back alert
                // presentations are occasionally dropped by SwiftUI.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    showFeedbackAlert = true
                }
            }
            Button("Yes") {
                AnalyticsService.shared.capture(.reviewGateAnswered, properties: ["answer": "yes"])
                // Let the gate alert fully dismiss before StoreKit
                // presents its sheet — back-to-back presentations can
                // swallow the review prompt.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    requestReview()
                }
            }
            .keyboardShortcut(.defaultAction)
        }
        .alert("What could be better?", isPresented: $showFeedbackAlert) {
            TextField("Your feedback", text: $feedbackText)
            Button("Send") { submitGateFeedback() }
            Button("Cancel", role: .cancel) { feedbackText = "" }
        } message: {
            Text("We read every one of these.")
        }
        .onAppear {
            evaluateEnjoymentGate()
            evaluateReengagement()
            evaluateTrialExpiring()
        }
        .onChange(of: premiumStore.productsLoaded) { _, _ in
            evaluateReengagement()
            evaluateTrialExpiring()
        }
        .onChange(of: premiumStore.isEligibleForTrial) { _, _ in evaluateReengagement() }
        .onChange(of: premiumStore.trialExpiresAt) { _, _ in evaluateTrialExpiring() }
        .onChange(of: premiumStore.isOnTrial) { _, _ in evaluateTrialExpiring() }
        .onChange(of: premiumGate.isPro) { _, isPro in
            // When the user upgrades (re-pro), clear the dedupe flag
            // so a future lapse can trigger the re-engagement again.
            // Idempotent — setting to false on every pro flip is fine.
            if isPro {
                UserDefaults.standard.set(false, forKey: Self.reengagementShownKey)
            }
            evaluateReengagement()
        }
    }

    /// Count this cold launch and decide whether to present the
    /// enjoyment gate. Mirrors the reengagement pattern: idempotent,
    /// UserDefaults-deduped (the gate shows exactly once per install),
    /// and deferred a beat so it never lands on top of the launch
    /// animation. Skipped while another auto-prompt is up — the gate
    /// can wait for launch #4; a stacked-sheet collision can't be
    /// undone.
    private func evaluateEnjoymentGate() {
        let defaults = UserDefaults.standard
        let openCount = defaults.integer(forKey: Self.appOpenCountKey) + 1
        defaults.set(openCount, forKey: Self.appOpenCountKey)

        guard !defaults.bool(forKey: Self.enjoymentGateShownKey),
              openCount >= Self.enjoymentGateMinOpens,
              !showReengagementPaywall,
              !showTrialExpiringPaywall,
              !PushService.shared.showSoftPrompt
        else { return }

        defaults.set(true, forKey: Self.enjoymentGateShownKey)
        AnalyticsService.shared.capture(.reviewGateShown, properties: ["open_count": openCount])
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            showEnjoymentGate = true
        }
    }

    /// Sends the gate's "Not really" feedback to PostHog — the v1
    /// feedback inbox. Empty submissions are dropped client-side; text
    /// is capped defensively so a paste-bomb can't bloat the event.
    private func submitGateFeedback() {
        let trimmed = feedbackText.trimmingCharacters(in: .whitespacesAndNewlines)
        feedbackText = ""
        guard !trimmed.isEmpty else { return }
        AnalyticsService.shared.capture(.feedbackSubmitted, properties: [
            "text": String(trimmed.prefix(1000)),
            "source": "enjoyment_gate",
        ])
        PAHaptics.tap()
    }

    /// Decide whether to auto-present the trial re-engagement paywall.
    /// Idempotent: returns early when any precondition isn't met, when
    /// the sheet's already up, or when we've already shown it for this
    /// lapse. Persists the "shown" flag to UserDefaults so cold
    /// launches don't re-prompt.
    private func evaluateReengagement() {
        let alreadyShown = UserDefaults.standard.bool(forKey: Self.reengagementShownKey)
        guard !alreadyShown,
              premiumStore.productsLoaded,
              !premiumGate.isPro,
              !premiumStore.isEligibleForTrial,
              !showReengagementPaywall
        else { return }

        UserDefaults.standard.set(true, forKey: Self.reengagementShownKey)
        showReengagementPaywall = true
    }

    /// Decide whether to auto-present the trial-expiring paywall.
    /// Fires when the user is currently inside an active trial whose
    /// expiration is within 48h. Dedupes per trial via a UserDefaults
    /// key keyed on the expiration epoch — a hypothetical future trial
    /// (different expiration) would get its own prompt. The reengagement
    /// dedupe is unrelated; both can fire over a user's lifetime, just
    /// not during the same trial period.
    private func evaluateTrialExpiring() {
        guard premiumStore.isOnTrial,
              let expires = premiumStore.trialExpiresAt,
              !showTrialExpiringPaywall
        else { return }

        let secondsUntilExpiry = expires.timeIntervalSinceNow
        guard secondsUntilExpiry > 0,
              secondsUntilExpiry <= 48 * 60 * 60
        else { return }

        let key = "\(Self.trialExpiringShownKeyPrefix)\(Int(expires.timeIntervalSince1970))"
        if UserDefaults.standard.bool(forKey: key) { return }

        UserDefaults.standard.set(true, forKey: key)
        showTrialExpiringPaywall = true
    }

    private func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(PA.Colors.surface)
        appearance.shadowColor = .clear

        let itemAppearance = UITabBarItemAppearance()
        itemAppearance.normal.iconColor = UIColor(PA.Colors.muted)
        itemAppearance.normal.titleTextAttributes = [.foregroundColor: UIColor(PA.Colors.muted)]
        itemAppearance.selected.iconColor = UIColor(PA.Colors.accent)
        itemAppearance.selected.titleTextAttributes = [.foregroundColor: UIColor(PA.Colors.accent)]

        appearance.stackedLayoutAppearance = itemAppearance
        appearance.inlineLayoutAppearance = itemAppearance
        appearance.compactInlineLayoutAppearance = itemAppearance

        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
}

// MARK: - (PortfolioTabView replaced by PortfolioView)

// MARK: - Profile Tab

struct ProfileTabView: View {
    private var auth: AuthService { AuthService.shared }

    @State private var profile: ProfileService.UserProfile?
    @State private var stats: ProfileService.ProfileStats?
    @State private var isLoading = false
    // Sign-out lives at the bottom of the profile screen, separated
    // from the navigational menu items above. Always confirmed via an
    // action sheet so a stray tap never logs the user out.
    @State private var showSignOutConfirmation = false
    // "Request a Feature" — native text-field alert whose submission
    // lands in PostHog (feature_requested with `text`); the v1 feature
    // request inbox, same pattern as the enjoyment gate's feedback path.
    @State private var showFeatureRequestAlert = false
    @State private var featureRequestText = ""

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                if auth.isAuthenticated {
                    profileContent
                } else {
                    guestProfileContent
                }
            }
        }
        .task {
            guard auth.isAuthenticated else { return }
            await loadProfile()
        }
        // Native text-field alert (the same Apple-UI-everywhere pattern
        // as the enjoyment gate). Submissions land in PostHog as
        // feature_requested events — the v1 feature-request inbox.
        .alert("Request a Feature", isPresented: $showFeatureRequestAlert) {
            TextField("What should PopAlpha do next?", text: $featureRequestText)
            Button("Send") { submitFeatureRequest() }
            Button("Cancel", role: .cancel) { featureRequestText = "" }
        } message: {
            Text("We read every one of these.")
        }
    }

    /// Sends the feature request to PostHog. Empty submissions are
    /// dropped client-side; text capped defensively.
    private func submitFeatureRequest() {
        let trimmed = featureRequestText.trimmingCharacters(in: .whitespacesAndNewlines)
        featureRequestText = ""
        guard !trimmed.isEmpty else { return }
        AnalyticsService.shared.capture(.featureRequested, properties: [
            "text": String(trimmed.prefix(1000)),
            "source": "profile_menu",
        ])
        PAHaptics.tap()
    }

    /// Menu row that opens the feature-request alert. A Button (not a
    /// NavigationLink) so it matches the row styling while presenting
    /// the alert in place.
    private var featureRequestRow: some View {
        Button {
            PAHaptics.tap()
            showFeatureRequestAlert = true
        } label: {
            profileMenuRow(icon: "lightbulb", title: "Request a Feature")
        }
        .buttonStyle(.plain)
    }

    // MARK: - Sign-in Prompt

    private var signInPrompt: some View {
        VStack(spacing: 24) {
            ZStack {
                Circle()
                    .stroke(PA.Colors.accent.opacity(0.3), lineWidth: 2)
                    .frame(width: 88, height: 88)

                Circle()
                    .fill(PA.Colors.surfaceSoft)
                    .frame(width: 80, height: 80)
                    .overlay(
                        Image("PopAlphaLogoTransparent")
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 40, height: 40)
                            .opacity(0.7)
                    )
            }

            VStack(spacing: 8) {
                Text("Sign in to PopAlpha")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)

                Text("Track your collection, follow collectors, and get personalized insights.")
                    .font(PA.Typography.cardSubtitle)
                    .foregroundStyle(PA.Colors.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }

            SignInProviderStack()
        }
        .padding(PA.Layout.sectionPadding)
    }

    // MARK: - Guest Profile Content (unauthenticated)

    private var guestProfileContent: some View {
        VStack(spacing: 24) {
            // Avatar placeholder
            ZStack {
                Circle()
                    .stroke(PA.Colors.accent.opacity(0.3), lineWidth: 2)
                    .frame(width: 88, height: 88)

                Circle()
                    .fill(PA.Colors.surfaceSoft)
                    .frame(width: 80, height: 80)
                    .overlay(
                        Image("PopAlphaLogoTransparent")
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 40, height: 40)
                            .opacity(0.7)
                    )
            }

            VStack(spacing: 8) {
                Text("Welcome to PopAlpha")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)

                Text("Sign in to track your collection, follow collectors, and get personalized insights.")
                    .font(PA.Typography.cardSubtitle)
                    .foregroundStyle(PA.Colors.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }

            SignInProviderStack()

            // Menu items (accessible without auth)
            VStack(spacing: 0) {
                NavigationLink {
                    WatchlistView()
                } label: {
                    profileMenuRow(icon: "heart", title: "Watchlist")
                }
                .buttonStyle(.plain)

                featureRequestRow

                NavigationLink {
                    SettingsView()
                } label: {
                    profileMenuRow(icon: "gearshape", title: "Settings", isLast: true)
                }
                .buttonStyle(.plain)
            }
            .glassSurface(radius: PA.Layout.panelRadius)

            Spacer()
        }
        .padding(PA.Layout.sectionPadding)
        .padding(.top, 40)
    }

    // MARK: - Profile Content (authenticated)

    private var profileContent: some View {
        VStack(spacing: 24) {
            // Avatar — Google profile picture if available, monogram fallback
            ZStack {
                Circle()
                    .stroke(PA.Colors.accent.opacity(0.3), lineWidth: 2)
                    .frame(width: 88, height: 88)

                if let urlString = auth.currentImageURL, let url = URL(string: urlString) {
                    LazyImage(url: url) { state in
                        if let image = state.image {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        } else {
                            monogramAvatar
                        }
                    }
                    .frame(width: 80, height: 80)
                    .clipShape(Circle())
                } else {
                    monogramAvatar
                }
            }

            VStack(spacing: 4) {
                Text(displayName)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)

                Text("@\(profile?.handle ?? displayHandle)")
                    .font(PA.Typography.cardSubtitle)
                    .foregroundStyle(PA.Colors.muted)

                if let bio = profile?.profileBio, !bio.isEmpty {
                    Text(bio)
                        .font(.system(size: 14))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                        .padding(.top, 4)
                }
            }

            // Stats row
            HStack(spacing: 32) {
                profileStat(value: "\(stats?.postCount ?? 0)", label: "Posts")
                profileStat(value: "\(stats?.followerCount ?? 0)", label: "Followers")
                profileStat(value: "\(stats?.followingCount ?? 0)", label: "Following")
            }
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
            .glassSurface(radius: PA.Layout.panelRadius)

            // Menu items
            VStack(spacing: 0) {
                NavigationLink {
                    WatchlistView()
                } label: {
                    profileMenuRow(icon: "heart", title: "Watchlist")
                }
                .buttonStyle(.plain)

                NavigationLink {
                    NotificationView()
                } label: {
                    profileMenuRow(icon: "bell.badge", title: "Activity")
                }
                .buttonStyle(.plain)

                featureRequestRow

                NavigationLink {
                    SettingsView()
                } label: {
                    profileMenuRow(icon: "gearshape", title: "Settings", isLast: true)
                }
                .buttonStyle(.plain)
            }
            .glassSurface(radius: PA.Layout.panelRadius)

            // Spacer pushes the sign-out CTA to the bottom of the
            // screen, visually separating it from the navigational
            // menu items above so it never reads as just-another-row.
            Spacer(minLength: 24)

            signOutButton
        }
        .padding(PA.Layout.sectionPadding)
        .padding(.top, 40)
        .confirmationDialog(
            "Sign out of PopAlpha?",
            isPresented: $showSignOutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Sign Out", role: .destructive) {
                AuthService.shared.signOut()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need to sign back in to see your watchlist, portfolio, and notifications.")
        }
    }

    // MARK: - Sign Out CTA

    /// Bottom-of-screen destructive button. Tinted red to read as
    /// distinct from the cyan accent used for everything else, and
    /// gated behind a confirmation sheet so a stray tap never logs
    /// the user out.
    private var signOutButton: some View {
        Button {
            PAHaptics.tap()
            showSignOutConfirmation = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 14, weight: .semibold))
                Text("Sign Out")
                    .font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(PA.Colors.negative)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(PA.Colors.negative.opacity(0.10))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(PA.Colors.negative.opacity(0.3), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var displayHandle: String {
        auth.currentHandle ?? "collector"
    }

    /// Google first name → handle → "collector"
    private var displayName: String {
        if let firstName = auth.currentFirstName, !firstName.isEmpty {
            return firstName
        }
        return profile?.handle ?? displayHandle
    }

    private var monogramAvatar: some View {
        Circle()
            .fill(PA.Colors.surfaceSoft)
            .frame(width: 80, height: 80)
            .overlay(
                Text(String(displayName.prefix(1)).uppercased())
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(PA.Colors.accent)
            )
    }

    private func profileStat(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)
            Text(label)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        // VoiceOver: read as "5 Posts" instead of two separate elements.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(label)")
    }

    private func profileMenuRow(icon: String, title: String, isLast: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(PA.Colors.accent)
                    .frame(width: 24)
                    // Decorative — title carries the same meaning.
                    .accessibilityHidden(true)

                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(PA.Colors.text)

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                    // Decorative — NavigationLink already announces "button".
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            // Force the entire row's bounding box to be hit-testable.
            // Without this, SwiftUI only registers taps on rendered
            // pixels — the Spacer() between title and chevron leaves
            // a dead zone mid-row and taps silently miss the
            // NavigationLink. This is a well-known SwiftUI gotcha for
            // custom NavigationLink labels.
            .contentShape(Rectangle())

            if !isLast {
                Divider()
                    .background(PA.Colors.border)
                    .padding(.leading, 52)
            }
        }
        // VoiceOver reads just the title; the icon + chevron are visual
        // chrome that don't add information.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }

    // MARK: - Data

    private func loadProfile() async {
        guard auth.isAuthenticated else { return }
        isLoading = true
        do {
            let (prof, _, profStats) = try await ProfileService.shared.fetchMyProfile()
            profile = prof
            stats = profStats
        } catch {
            // Silently fail — profile tab still shows cached/default data
        }
        isLoading = false
    }
}

// MARK: - Sign-In Buttons
//
// Reusable wide pill CTAs used on sign-in prompts throughout the app.
// Both observe AuthService.isSigningIn so the label flips to "Signing
// in…" with a spinner and the button disables itself while the flow is
// in flight — prevents double-taps and makes intent visible while
// AuthenticationServices is presenting. The shared guard in AuthService
// also prevents triggering Google + Apple in parallel.
//
// Per Apple HIG, when a third-party provider (Google) is offered, Apple
// Sign In must be offered with equal prominence. Use `SignInProviderStack`
// to place both as a vertical pair rather than wiring each site by hand.

struct PrimarySignInButton: View {
    var title: String = "Continue with Google"
    var maxWidth: CGFloat = 260
    private var auth: AuthService { AuthService.shared }

    /// Optional override action — used by the SignInSheet chooser phase
    /// where Google's tap also needs to dismiss the sheet. Default
    /// (nil) calls AuthService directly so SignInProviderStack and
    /// other inline call sites keep their one-tap behavior.
    var action: (() -> Void)? = nil

    var body: some View {
        Button {
            if let action {
                action()
            } else {
                AuthService.shared.signInWithGoogle()
            }
        } label: {
            HStack(spacing: 8) {
                if auth.isSigningIn {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .controlSize(.small)
                        .tint(PA.Colors.background)
                } else {
                    Image(systemName: "g.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(PA.Colors.background)
                }
                Text(auth.isSigningIn ? "Signing in…" : title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
            }
            .frame(maxWidth: maxWidth)
            .padding(.vertical, 14)
            .background(PA.Colors.accent.opacity(auth.isSigningIn ? 0.6 : 1.0))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(auth.isSigningIn)
    }
}

struct PrimaryAppleSignInButton: View {
    var title: String = "Continue with Apple"
    var maxWidth: CGFloat = 260
    /// See PrimarySignInButton.action — same pattern.
    var action: (() -> Void)? = nil
    private var auth: AuthService { AuthService.shared }

    var body: some View {
        Button {
            if let action {
                action()
            } else {
                AuthService.shared.signInWithApple()
            }
        } label: {
            HStack(spacing: 8) {
                if auth.isSigningIn {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Image(systemName: "applelogo")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                }
                Text(auth.isSigningIn ? "Signing in…" : title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(maxWidth: maxWidth)
            .padding(.vertical, 14)
            .background(Color.black.opacity(auth.isSigningIn ? 0.6 : 1.0))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(Color.white.opacity(0.15), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(auth.isSigningIn)
    }
}

/// Convenience: all providers stacked vertically, spaced for thumb use.
/// Drop this in wherever we used to render a single Sign In button.
/// Each provider button still goes directly to its provider — the user
/// has visibly chosen by tapping a specific brand. The chooser-style
/// SignInSheet is used by the generic shortcut "Sign In" buttons
/// scattered across the app.
struct SignInProviderStack: View {
    var maxWidth: CGFloat = 260

    @State private var showEmailSheet = false

    var body: some View {
        VStack(spacing: 10) {
            PrimarySignInButton(maxWidth: maxWidth)
            PrimaryAppleSignInButton(maxWidth: maxWidth)
            PrimaryEmailSignInButton(maxWidth: maxWidth) {
                showEmailSheet = true
            }
        }
        .sheet(isPresented: $showEmailSheet) {
            // User explicitly tapped Email here, so skip the chooser
            // and drop them straight into the email-entry phase.
            SignInSheet(startingPhase: .email)
        }
    }
}

/// "Continue with Email" CTA, styled as a stroked secondary button so
/// it reads as a fallback to the two OAuth options above without
/// competing for visual weight.
struct PrimaryEmailSignInButton: View {
    var title: String = "Continue with Email"
    var maxWidth: CGFloat = 260
    var action: () -> Void

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "envelope")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
            }
            .frame(maxWidth: maxWidth)
            .padding(.vertical, 14)
            .background(PA.Colors.surfaceSoft)
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(PA.Colors.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(auth.isSigningIn)
    }
}

// MARK: - Tab Enum

enum AppTab {
    case market, search, scanner, portfolio, profile
}

// MARK: - Previews

#Preview("App") {
    ContentView()
        .preferredColorScheme(.dark)
}

#Preview("Profile") {
    ProfileTabView()
        .preferredColorScheme(.dark)
}
