import SwiftUI
import NukeUI
import PhotosUI
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

    // App Store review ask — StoreKit's system prompt, invoked directly
    // on the 3rd cold launch (Apple's HIG: ask only after demonstrated
    // engagement; the sheet is capped at 3 shows/365d and StoreKit
    // decides whether it actually appears). No custom pre-prompt: App
    // Review guideline 5.6.1 disallows custom review prompts, so
    // feedback is collected on a separate surface instead (Profile →
    // Request a Feature).
    @Environment(\.requestReview) private var requestReview
    private static let appOpenCountKey = "ai.popalpha.review.appOpenCount"
    // Key string predates the removal of the enjoyment-gate pre-prompt;
    // kept so installs that already saw a prompt aren't re-asked.
    private static let reviewRequestedKey = "ai.popalpha.review.gateShown"
    private static let reviewRequestMinOpens = 3

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
        .minimizingTabBar()
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
        .onAppear {
            // Paywall evaluators run first so the review ask's initial
            // guard sees any same-tick sheet decision; the review ask
            // also re-checks at request time for the async cases (e.g.
            // re-engagement firing when products load).
            evaluateReengagement()
            evaluateTrialExpiring()
            evaluateReviewRequest()
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

    /// Count this cold launch and decide whether to hand off to
    /// StoreKit's review prompt. Mirrors the reengagement pattern:
    /// idempotent, UserDefaults-deduped (we ask once per install;
    /// StoreKit's own 3-per-365d cap governs beyond that), and deferred
    /// a beat so it never lands on top of the launch animation. Skipped
    /// while another auto-prompt is up — the ask can wait for launch
    /// #4; a stacked-sheet collision can't be undone.
    private func evaluateReviewRequest() {
        let defaults = UserDefaults.standard
        let openCount = defaults.integer(forKey: Self.appOpenCountKey) + 1
        defaults.set(openCount, forKey: Self.appOpenCountKey)

        guard !defaults.bool(forKey: Self.reviewRequestedKey),
              openCount >= Self.reviewRequestMinOpens,
              !showReengagementPaywall,
              !showTrialExpiringPaywall,
              !PushService.shared.showSoftPrompt
        else { return }

        // Burn the dedupe key up front so a re-entrant appear can't
        // double-schedule — but RE-CHECK at request time and un-burn if
        // another auto-prompt won the launch in the meantime. The
        // paywall evaluators run after this one (and the re-engagement
        // check re-fires asynchronously when products load), so a sheet
        // can appear inside the 2s window; requesting the review under
        // it would waste the once-per-install ask (Codex P2 on PR #220).
        defaults.set(true, forKey: Self.reviewRequestedKey)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            guard !showReengagementPaywall,
                  !showTrialExpiringPaywall,
                  !PushService.shared.showSoftPrompt
            else {
                // Another prompt owns this launch — release the key so
                // the ask retries cleanly on the next cold launch.
                defaults.set(false, forKey: Self.reviewRequestedKey)
                return
            }
            AnalyticsService.shared.capture(.reviewPromptRequested, properties: ["open_count": openCount])
            requestReview()
        }
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
        // iOS 26+ renders the tab bar as floating Liquid Glass (blurred,
        // morphing, Instagram-style). Forcing the legacy opaque appearance
        // below suppresses that entirely, so the override is legacy-only;
        // on glass, selected tint comes from .tint() on the TabView and
        // unselected items use the system glass styling.
        if #available(iOS 26.0, *) { return }

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

// MARK: - Liquid Glass tab bar

private extension View {
    /// Instagram-style minimizing tab bar: the iOS 26 Liquid Glass bar
    /// shrinks out of the way on scroll-down and restores on scroll-up.
    /// No-op on earlier OSes, which keep the legacy opaque bar from
    /// configureTabBarAppearance().
    @ViewBuilder
    func minimizingTabBar() -> some View {
        if #available(iOS 26.0, *) {
            self.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
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
    // Profile editing — tap the avatar to pick a new photo, tap the @handle
    // to rename. Both write through ProfileService and refresh in place.
    @State private var avatarPickerItem: PhotosPickerItem?
    @State private var avatarUploading = false
    @State private var showHandleEditor = false
    @State private var handleDraft = ""
    @State private var profileEditError: String?

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
                            // Fill the 80pt circle — the PNG carries its
                            // own transparent margins, so anything under
                            // ~76pt still read as a small badge rather
                            // than an avatar (40pt originally, 64pt on
                            // first pass — both too timid).
                            .frame(width: 76, height: 76)
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
                            // Fill the 80pt circle — the PNG carries its
                            // own transparent margins, so anything under
                            // ~76pt still read as a small badge rather
                            // than an avatar (40pt originally, 64pt on
                            // first pass — both too timid).
                            .frame(width: 76, height: 76)
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
            // Avatar — tap to pick a new photo. PopAlpha-stored avatar wins,
            // then the Google/Clerk picture, then a monogram. A camera badge
            // signals it's editable; an overlay shows while the upload is
            // in flight.
            PhotosPicker(selection: $avatarPickerItem, matching: .images, photoLibrary: .shared()) {
                ZStack {
                    Circle()
                        .stroke(PA.Colors.accent.opacity(0.3), lineWidth: 2)
                        .frame(width: 88, height: 88)

                    avatarImage
                        .frame(width: 80, height: 80)
                        .clipShape(Circle())

                    if avatarUploading {
                        Circle()
                            .fill(Color.black.opacity(0.45))
                            .frame(width: 80, height: 80)
                        ProgressView()
                            .progressViewStyle(.circular)
                            .tint(.white)
                    }

                    // Camera badge, bottom-trailing.
                    Image(systemName: "camera.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(PA.Colors.background)
                        .frame(width: 26, height: 26)
                        .background(PA.Colors.accent)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(PA.Colors.background, lineWidth: 2))
                        .offset(x: 30, y: 30)
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.plain)
            .disabled(avatarUploading)
            .accessibilityLabel("Change profile photo")
            .onChange(of: avatarPickerItem) { _, newItem in
                guard let newItem else { return }
                Task { await handleAvatarPick(newItem) }
            }

            VStack(spacing: 4) {
                Text(displayName)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)

                // Tap the @handle to rename. A pencil hints it's editable.
                Button {
                    PAHaptics.tap()
                    handleDraft = profile?.handle ?? displayHandle
                    showHandleEditor = true
                } label: {
                    HStack(spacing: 4) {
                        Text("@\(profile?.handle ?? displayHandle)")
                            .font(PA.Typography.cardSubtitle)
                            .foregroundStyle(PA.Colors.muted)
                        Image(systemName: "pencil")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(PA.Colors.accent)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Edit handle, currently @\(profile?.handle ?? displayHandle)")

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
        // Rename the collector handle. Validation mirrors the server
        // (PATCH /api/profile): 3–20 chars, lowercase letters/numbers/underscore.
        .alert("Edit Handle", isPresented: $showHandleEditor) {
            TextField("handle", text: $handleDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
            Button("Save") { Task { await saveHandle() } }
            Button("Cancel", role: .cancel) { handleDraft = "" }
        } message: {
            Text("3–20 characters: lowercase letters, numbers, and underscores.")
        }
        // Surfaces avatar-upload / handle-save failures so a tap that
        // silently fails doesn't leave the user guessing.
        .alert(
            "Couldn't update profile",
            isPresented: Binding(
                get: { profileEditError != nil },
                set: { if !$0 { profileEditError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { profileEditError = nil }
        } message: {
            Text(profileEditError ?? "Please try again.")
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

    /// Avatar image: PopAlpha-stored picture wins, then the Google/Clerk
    /// picture, then a monogram. Used as the PhotosPicker label.
    @ViewBuilder
    private var avatarImage: some View {
        if let urlString = profile?.profileImageUrl ?? auth.currentImageURL,
           let url = URL(string: urlString) {
            LazyImage(url: url) { state in
                if let image = state.image {
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    monogramAvatar
                }
            }
        } else {
            monogramAvatar
        }
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

    /// Picked-photo → downscale → JPEG → base64 data URL → upload. We resize
    /// to 512px and re-encode at 0.8 quality so the request stays small (well
    /// under the route's cap) and the stored avatar is web/feed-friendly.
    private func handleAvatarPick(_ item: PhotosPickerItem) async {
        avatarUploading = true
        defer {
            avatarUploading = false
            // Allow re-picking the same photo later.
            avatarPickerItem = nil
        }
        do {
            guard
                let data = try await item.loadTransferable(type: Data.self),
                let uiImage = UIImage(data: data)
            else {
                profileEditError = "That image couldn't be read. Try another photo."
                return
            }

            let target: CGFloat = 512
            let longest = max(uiImage.size.width, uiImage.size.height)
            let scale = longest > target ? target / longest : 1
            let newSize = CGSize(width: uiImage.size.width * scale, height: uiImage.size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            let resized = renderer.image { _ in
                uiImage.draw(in: CGRect(origin: .zero, size: newSize))
            }
            guard let jpeg = resized.jpegData(compressionQuality: 0.8) else {
                profileEditError = "That image couldn't be processed. Try another photo."
                return
            }

            let dataUrl = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
            _ = try await ProfileService.shared.uploadAvatar(dataUrl: dataUrl)
            PAHaptics.success()
            await loadProfile()
        } catch {
            // Prefer the server's reason (unsupported format, too large, …);
            // fall back to a connection-oriented message for transport errors.
            profileEditError = (error as? APIError)?.serverMessage
                ?? "Upload failed. Check your connection and try again."
        }
    }

    /// Saves a new handle. A cheap length/charset pre-check avoids an obvious
    /// round-trip; the server is authoritative for the rest (no leading/trailing
    /// or double underscores, reserved names, uniqueness) and its specific
    /// message is surfaced rather than mirroring — and drifting from — its rules.
    private func saveHandle() async {
        let trimmed = handleDraft.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        handleDraft = ""
        guard !trimmed.isEmpty else { return }

        let valid = trimmed.range(of: "^[a-z0-9_]{3,20}$", options: .regularExpression) != nil
        guard valid else {
            profileEditError = "Handles must be 3–20 characters: lowercase letters, numbers, and underscores."
            return
        }
        // No-op if unchanged.
        guard trimmed != (profile?.handle ?? displayHandle) else { return }

        do {
            try await ProfileService.shared.updateProfile(handle: trimmed, bio: nil)
            auth.setLocalHandle(trimmed)
            PAHaptics.success()
            await loadProfile()
        } catch {
            // Show the server's specific reason (reserved, underscore rules,
            // already taken, …) when it sent one; otherwise a generic fallback.
            profileEditError = (error as? APIError)?.serverMessage
                ?? "That handle is taken or invalid. Try another."
        }
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
