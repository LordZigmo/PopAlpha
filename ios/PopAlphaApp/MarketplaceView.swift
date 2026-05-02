import SwiftUI

// MARK: - Marketplace (home screen)
//
// Post-Apr 2026 rebalance (see docs/plans/jazzy-rolling-rocket.md).
//
// Section order — top to bottom:
//
//   1. TopBar                  (compact 44pt — logo · search · alerts · avatar)
//   2. PersonalPulseSection    ("my PopAlpha" — watchlist · portfolio · style)
//   3. SignalBoardView, which in turn renders:
//        • AIBriefCard          (editorial anchor, style-aware tertiary)
//        • ForYouRail           (personalized rail + rationale chips)
//        • MarketPulseSection   (tabbed: Movers / Breakouts / Unusual / Pullbacks
//                                + folded KPI strip + 24H / 7D toggle)
//        • CommunitySection     (reframed as "COLLECTORS LIKE YOU" when styled)
//        • Footer
//
// Key shifts from the old layout:
//   • TodayPulseStrip was deleted from the top — its KPIs now live inside
//     MarketPulseSection's header so the top of the screen is personal /
//     editorial, not a broad market readout.
//   • YourWorldSection was replaced by the slimmer PersonalPulseSection
//     (compact chip row, not a full-bleed CTA panel).
//   • Four stacked MoverSections collapsed into one MarketPulseSection
//     with a segmented control — same content, ~¾ less scroll.
//
// Data ownership:
//   • MarketplaceView owns personalization profile + /me + KPI stats, and
//     passes them into SignalBoardView as props.
//   • SignalBoardView owns the /api/homepage fetch, the AI brief, and
//     the community data.

struct MarketplaceView: View {
    @State private var pricesRefreshed24h: Int?
    @State private var avgChange24h: Double?
    @State private var marketCap: Double?
    @State private var meData: HomepageMeDTO?
    @State private var styleLabel: String?
    @State private var showSearch = false
    @State private var selectedWindow: SignalWindow = .h24
    @State private var searchSelectedCard: MarketCard?

    var body: some View {
        NavigationStack {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 16) {
                    TopBar(showSearch: $showSearch)
                        .padding(.horizontal, PA.Layout.sectionPadding)
                        .padding(.top, 8)

                    // 2. PersonalPulseSection — the first thing a collector
                    //    sees should be *theirs*, not the broad market.
                    PersonalPulseSection(me: meData, styleLabel: styleLabel)
                        .padding(.horizontal, PA.Layout.sectionPadding)

                    // 3. SignalBoardView — AI Brief · For You · Market Pulse ·
                    //    Community · Footer. Fetches /api/homepage itself;
                    //    takes personalization context as props.
                    SignalBoardView(
                        selectedWindow: $selectedWindow,
                        styleLabel: styleLabel,
                        meData: meData,
                        pricesRefreshed24h: pricesRefreshed24h,
                        avgChange24h: avgChange24h,
                        marketCap: marketCap
                    )
                }
                .padding(.bottom, 32)
            }
            .background(PA.Colors.background)
            .refreshable {
                await loadAll()
            }
            // .task(id:) prevents the home-tab data from reloading (and
            // resetting scroll position) every time the user pops back
            // from a card detail view. Fetches once per session and
            // only re-fires when auth state flips. Pull-to-refresh
            // covers explicit refresh requests.
            .task(id: AuthService.shared.isAuthenticated) {
                await loadAll()
            }
            .fullScreenCover(isPresented: $showSearch) {
                NavigationStack {
                    SearchView(onSelectCard: { result in
                        showSearch = false
                        Task {
                            try? await Task.sleep(for: .milliseconds(300))
                            await MainActor.run {
                                searchSelectedCard = MarketCard.stub(
                                    slug: result.canonicalSlug,
                                    name: result.canonicalName,
                                    setName: result.setName ?? "",
                                    cardNumber: result.cardNumber ?? "",
                                    imageURL: result.imageURL
                                )
                            }
                        }
                    })
                }
            }
            .navigationDestination(item: $searchSelectedCard) { card in
                CardDetailView(card: card)
            }
            // Universal Links — DeepLinkRouter parses popalpha.ai URLs in
            // ContentView.onContinueUserActivity and stashes a pending
            // destination. We reuse the search → searchSelectedCard →
            // navigationDestination pipeline (both flows produce a stub
            // MarketCard from a slug; CardDetailView hydrates the rest
            // via .task on appear). onAppear handles the cold-launch
            // case where the router was set before MarketplaceView
            // mounted; onChange handles the warm-app-already-running
            // case.
            .onAppear { consumePendingDeepLink() }
            .onChange(of: DeepLinkRouter.shared.pendingDestination) { _, _ in
                consumePendingDeepLink()
            }
        }
    }

    /// If the DeepLinkRouter is holding a pending `.card(slug:)`
    /// destination, hydrate a stub MarketCard and trigger
    /// navigation, then consume the router state so a re-render
    /// doesn't push the same destination twice.
    private func consumePendingDeepLink() {
        guard case let .card(slug) = DeepLinkRouter.shared.pendingDestination else {
            return
        }
        searchSelectedCard = MarketCard.stub(slug: slug)
        DeepLinkRouter.shared.consume()
    }

    // MARK: - Data loaders

    private func loadAll() async {
        async let statsTask: Void = loadStats()
        async let meTask: HomepageMeDTO? = {
            do { return try await CardService.shared.fetchHomepageMe() }
            catch { return nil }
        }()
        async let profileTask: PersonalizedProfileResponse? =
            PersonalizationService.shared.fetchProfile()

        _ = await statsTask
        let me = await meTask
        let profile = await profileTask
        await MainActor.run {
            meData = me
            // Only surface a style label when the profile actually has
            // one — the server returns nil/empty for low-event actors.
            styleLabel = profile?.profile?.dominantStyleLabel
                .flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    private func loadStats() async {
        let count = try? await CardService.shared.fetchPricesRefreshedToday()
        let avg = try? await CardService.shared.fetchAvgChange24h()
        let cap = try? await CardService.shared.fetchMarketCap()
        await MainActor.run {
            pricesRefreshed24h = count
            avgChange24h = avg
            marketCap = cap
        }
    }
}

// MARK: - Top Bar (44pt)

private struct TopBar: View {
    @Binding var showSearch: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image("PopAlphaLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 26, height: 26)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

            Text("PopAlpha")
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(PA.Colors.text)

            Spacer()

            Button {
                showSearch = true
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(PA.Colors.surfaceSoft)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)

            NavigationLink {
                NotificationView()
            } label: {
                Image(systemName: "bell.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(PA.Colors.surfaceSoft)
                    .clipShape(Circle())
            }
            .hapticTap()

            Circle()
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 28, height: 28)
                .overlay(
                    Image(systemName: "person.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(PA.Colors.muted)
                )
        }
        .frame(height: 44)
    }
}

#Preview("Marketplace") {
    MarketplaceView()
        .preferredColorScheme(.dark)
}
