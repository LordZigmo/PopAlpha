import SwiftUI
import NukeUI

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
            MarketplaceView()
                .tabItem {
                    Label("Market", systemImage: "chart.line.uptrend.xyaxis")
                }
                .tag(AppTab.market)

            ActivityFeedView()
                .tabItem {
                    Label("Feed", systemImage: "newspaper.fill")
                }
                .tag(AppTab.activity)

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
                    profileMenuRow(icon: "bell", title: "Notifications")
                }
                .buttonStyle(.plain)

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

    var body: some View {
        Button {
            AuthService.shared.signIn()
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
    private var auth: AuthService { AuthService.shared }

    var body: some View {
        Button {
            AuthService.shared.signInWithApple()
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

/// Convenience: both providers stacked vertically, spaced for thumb use.
/// Drop this in wherever we used to render a single Sign In button.
struct SignInProviderStack: View {
    var maxWidth: CGFloat = 260

    var body: some View {
        VStack(spacing: 10) {
            PrimarySignInButton(maxWidth: maxWidth)
            PrimaryAppleSignInButton(maxWidth: maxWidth)
        }
    }
}

// MARK: - Tab Enum

enum AppTab {
    case market, activity, scanner, portfolio, profile
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
