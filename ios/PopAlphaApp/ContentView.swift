import SwiftUI
import NukeUI

struct ContentView: View {
    @State private var selectedTab: AppTab = .market

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

            Button {
                AuthService.shared.signIn()
            } label: {
                Text("Sign In")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .frame(maxWidth: 200)
                    .padding(.vertical, 14)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
            }
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

            Button {
                AuthService.shared.signIn()
            } label: {
                Text("Sign In")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .frame(maxWidth: 200)
                    .padding(.vertical, 14)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
            }

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
                profileMenuItem(icon: "folder", title: "Portfolio")
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
                    profileMenuRow(icon: "gearshape", title: "Settings")
                }
                .buttonStyle(.plain)

                profileMenuItem(icon: "questionmark.circle", title: "Help", isLast: true)
            }
            .glassSurface(radius: PA.Layout.panelRadius)

            Spacer()
        }
        .padding(PA.Layout.sectionPadding)
        .padding(.top, 40)
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
    }

    private func profileMenuItem(icon: String, title: String, isLast: Bool = false) -> some View {
        profileMenuRow(icon: icon, title: title, isLast: isLast)
    }

    private func profileMenuRow(icon: String, title: String, isLast: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(PA.Colors.accent)
                    .frame(width: 24)

                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(PA.Colors.text)

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)

            if !isLast {
                Divider()
                    .background(PA.Colors.border)
                    .padding(.leading, 52)
            }
        }
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
