import SwiftUI
import OSLog

// MARK: - Marketplace (home screen)
//
// Post-May 2026 hero rebalance (replaces the post-Apr 2026 layout
// described in docs/plans/jazzy-rolling-rocket.md). Restructured so the
// scanner-and-market-intelligence wedge is the FIRST thing a new user
// sees — the old top of screen led with a sign-in banner and a generic
// AI brief, which never communicated what PopAlpha actually does in the
// first three seconds. Reordering puts the value prop (hero) up top,
// and demotes the sign-in CTA to a richer "make this yours" card placed
// after the user has already seen the app's market read.
//
// Section order — guest (logged-out):
//
//   1. TopBar
//   2. MarketHeroCard       — "The fastest way to understand a Pokémon card."
//   3. AIBriefCard          — editorial market read
//   4. MarketPulseSection   — movers (data-gated)
//   5. SignInPromoCard      — "Make PopAlpha yours" (moved down from top)
//   6. ForYouRail           — falls back to "POPULAR WITH COLLECTORS"
//   7. CommunitySection
//   8. Footer
//
// Section order — authed (signed-in):
//
//   1. TopBar
//   2. PersonalPulseSection — Watchlist · Portfolio · Style chips
//   3. AIBriefCard          — personalized market read
//   4. MarketScanStrip      — slim "Scan a card" reminder
//   5. ForYouRail           — "FOR YOU"
//   6. MarketPulseSection   — movers (data-gated)
//   7. CommunitySection     — "COLLECTORS LIKE YOU" when style known
//   8. Footer
//
// Data ownership:
//   • MarketplaceView owns ALL homepage fetches: KPI stats, /me,
//     personalization profile, /api/homepage signal board, AI brief, and
//     community. They run in parallel via `async let`. Hoisting them
//     here (instead of splitting between MarketplaceView and the old
//     SignalBoardView) keeps the loading state coherent and lets a
//     single pull-to-refresh refresh everything.

struct MarketplaceView: View {
    /// Bound from ContentView so the Hero / Scan Strip CTAs can switch
    /// the bottom-nav tab to `.scanner` without going through a
    /// singleton or NotificationCenter.
    @Binding var selectedTab: AppTab

    // MARK: KPI strip data (folded into MarketPulseSection's header)
    @State private var pricesRefreshed24h: Int?
    @State private var avgChange24h: Double?
    @State private var marketCap: Double?

    // MARK: Personal context
    @State private var meData: HomepageMeDTO?
    @State private var styleLabel: String?

    // MARK: Signal board data (hoisted from the old SignalBoardView)
    @State private var data: HomepageDataDTO?
    @State private var aiBrief: HomepageAIBriefDTO?
    @State private var community: HomepageCommunityDTO?
    @State private var isLoading = true
    @State private var loadError: String?

    // MARK: UI state
    @State private var showSearch = false
    @State private var selectedWindow: SignalWindow = .h24
    @State private var searchSelectedCard: MarketCard?
    /// Card pushed by tapping a row in ForYou / MarketPulse / Community.
    /// Kept separate from `searchSelectedCard` so the two pipelines
    /// don't fight over the same NavigationStack destination state.
    @State private var selectedCard: MarketCard?

    /// Timestamp of the last loadAll fire. Used to debounce runaway
    /// .task re-fires triggered by @Observable churn (e.g., when
    /// AuthService.handleServerAuthRejection sets isAuthenticated =
    /// false and cascading Clerk SDK state writes invalidate the
    /// MarketplaceView body in a tight loop). Real-device 2026-05-05:
    /// after a 401 on /api/scan/correction, this view fired
    /// fetchAIBrief + fetchHomepageCommunity hundreds of times per
    /// second, each cancelled by the next, until the user force-quit.
    /// 1.5s window is well above any legitimate auth-flip cadence
    /// (real auth flips happen on user action, not every frame).
    @State private var lastLoadAllFiredAt: Date?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    // Tighter spacing (was 16) so the first row of the
                    // movers section is visible above the fold on
                    // typical iPhones — the live-market proof should
                    // come into view shortly after the hero / brief.
                    VStack(spacing: 14) {
                        TopBar(showSearch: $showSearch)
                            .padding(.horizontal, PA.Layout.sectionPadding)
                            .padding(.top, 8)

                        if AuthService.shared.isAuthenticated {
                            authedSequence(proxy: proxy)
                        } else {
                            guestSequence(proxy: proxy)
                        }
                    }
                    .padding(.bottom, 32)
                }
                .background(PA.Colors.background)
                .refreshable {
                    await loadAll()
                }
                // .task(id:) so the page only re-fetches when auth
                // state flips — not on every back-pop from a card
                // detail. Manual refresh still goes through
                // .refreshable. Attached to the inner ScrollView (not
                // the ScrollViewReader wrapper) to match the lifecycle
                // pattern the previous SignalBoardView relied on.
                .task(id: AuthService.shared.isAuthenticated) {
                    await loadAll()
                }
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
            .navigationDestination(item: $selectedCard) { card in
                CardDetailView(card: card)
            }
            // Universal Links — DeepLinkRouter parses popalpha.ai URLs in
            // ContentView.onContinueUserActivity and stashes a pending
            // destination. We reuse the search → searchSelectedCard →
            // navigationDestination pipeline.
            .onAppear { consumePendingDeepLink() }
            .onChange(of: DeepLinkRouter.shared.pendingDestination) { _, _ in
                consumePendingDeepLink()
            }
        }
    }

    // MARK: - Section sequences

    @ViewBuilder
    private func guestSequence(proxy: ScrollViewProxy) -> some View {
        // 1. Hero — answers "what is this?" in 3 seconds.
        MarketHeroCard(
            onScan: { handleScanCTA() },
            onSeeMovers: { handleSeeMoversCTA(proxy: proxy) }
        )
        .padding(.horizontal, PA.Layout.sectionPadding)

        // 2. AI Brief — handles its own placeholder when brief is nil.
        AIBriefCard(brief: aiBrief, fallbackAsOf: data?.asOf, styleLabel: styleLabel)
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 3. Movers FIRST for guests — they don't have a personalized
        //    profile yet, so the broad market read carries more weight
        //    than a curated rail.
        moversSection

        // 4. Sign-in promo — moved down from the top of screen. By now
        //    the guest has seen the value prop and a market read; the
        //    ask lands as "make this yours" rather than "log in to use
        //    the app."
        SignInPromoCard()
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 5. ForYou rail — eyebrow falls back to "POPULAR WITH COLLECTORS".
        if let data {
            ForYouRail(
                signalBoard: data.signalBoard,
                fallbackWindow: selectedWindow,
                hasProfile: false,
                onSelect: handleSelect
            )
        }

        // 6. Community
        if let community, !(community.trending.isEmpty && community.mostSaved.isEmpty && community.friendsAdded.isEmpty) {
            CommunitySection(data: community, styleLabel: styleLabel)
        }

        // 7. Footer
        if let asOf = data?.asOf {
            footer(asOf: asOf)
        }
    }

    @ViewBuilder
    private func authedSequence(proxy: ScrollViewProxy) -> some View {
        // 1. PersonalPulse — Watchlist · Portfolio · Style chips. Only
        //    renders when authed (the section now early-returns on
        //    guest, replaced by MarketHeroCard at the top of screen).
        PersonalPulseSection(me: meData, styleLabel: styleLabel)
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 2. AI Brief — personalized when style is known.
        AIBriefCard(brief: aiBrief, fallbackAsOf: data?.asOf, styleLabel: styleLabel)
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 3. Compact scan strip — keeps scan one tap away even though
        //    the Scan tab is in the bottom nav. New collectors haven't
        //    yet internalized the tab order, so a visible CTA on the
        //    home tab is still a discoverability win.
        MarketScanStrip(
            onScan: { handleScanCTA() },
            onSeeMovers: { handleSeeMoversCTA(proxy: proxy) }
        )
        .padding(.horizontal, PA.Layout.sectionPadding)

        // 4. ForYou rail — first because the user has a profile.
        if let data {
            ForYouRail(
                signalBoard: data.signalBoard,
                fallbackWindow: selectedWindow,
                hasProfile: styleLabel != nil,
                onSelect: handleSelect
            )
        }

        // 5. Movers
        moversSection

        // 6. Community — eyebrow becomes "COLLECTORS LIKE YOU" when
        //    style label is known (handled inside the section).
        if let community, !(community.trending.isEmpty && community.mostSaved.isEmpty && community.friendsAdded.isEmpty) {
            CommunitySection(data: community, styleLabel: styleLabel)
        }

        // 7. Footer
        if let asOf = data?.asOf {
            footer(asOf: asOf)
        }
    }

    // MARK: - Movers section + loading/error placeholder
    //
    // Tagged with `.id("movers")` so the hero / scan-strip "See what's
    // moving" CTA can scroll directly to it via ScrollViewReader. We
    // tag the placeholder too, so the anchor exists even before the
    // data fetch completes.

    @ViewBuilder
    private var moversSection: some View {
        if let data {
            MarketPulseSection(
                selectedWindow: $selectedWindow,
                signalBoard: data.signalBoard,
                highConfidenceMovers: data.highConfidenceMovers,
                watchlistSlugs: watchlistSlugs,
                pricesRefreshed24h: pricesRefreshed24h,
                avgChange24h: avgChange24h,
                marketCap: marketCap,
                onSelect: handleSelect
            )
            .id("movers")
        } else {
            signalPlaceholder
                .id("movers")
        }
    }

    @ViewBuilder
    private var signalPlaceholder: some View {
        if let error = loadError {
            errorState(error)
        } else if isLoading {
            loadingState
        } else {
            emptyState
        }
    }

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView().tint(PA.Colors.accent)
            Text("Loading market signals...")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("Couldn't load signals")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text(message)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .lineLimit(3)
            Button {
                Task { await loadAll() }
            } label: {
                Text("Retry")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(PA.Colors.accent.opacity(0.12))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
        .padding(.horizontal, 32)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("No signals available")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("Pull down to refresh")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    @ViewBuilder
    private func footer(asOf: String) -> some View {
        Text("Data as of \(formatAsOf(asOf)) · Scrydex & PokémonTCG")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(PA.Colors.muted)
            .padding(.top, 8)
            .frame(maxWidth: .infinity)
    }

    private func formatAsOf(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let df = DateFormatter()
        df.dateFormat = "h:mm a"
        return df.string(from: date)
    }

    /// Slugs of cards the signed-in user is watching — used by
    /// MarketPulseSection to annotate rows with a "Watchlist spike"
    /// rationale chip. Empty set for guests / missing data.
    private var watchlistSlugs: Set<String> {
        Set((meData?.watchlistMovers ?? []).map { $0.slug })
    }

    // MARK: - CTA handlers

    private func handleScanCTA() {
        PAHaptics.tap()
        selectedTab = .scanner
    }

    private func handleSeeMoversCTA(proxy: ScrollViewProxy) {
        PAHaptics.tap()
        withAnimation(.easeInOut(duration: 0.4)) {
            proxy.scrollTo("movers", anchor: .top)
        }
    }

    private func handleSelect(_ card: HomepageCardDTO) {
        PAHaptics.tap()
        selectedCard = card.toMarketCard()
    }

    // MARK: - Deep link

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
        // Debounce against runaway .task re-fires. Real-device
        // 2026-05-05: after a 401 on a scanner correction submit,
        // AuthService.handleServerAuthRejection's cleanup chain
        // cascaded @Observable invalidations through
        // MarketplaceView's body, causing .task(id: isAuthenticated)
        // to cancel-and-restart hundreds of times per second.
        // Each restart kicked off fetchAIBrief +
        // fetchHomepageCommunity, immediately cancelled by the next,
        // flooding the console with "cancelled" errors. 1.5s window
        // is well above any legitimate user-driven re-fire cadence
        // (auth state flips happen on real user actions, not at
        // SwiftUI body-recompute frequency); manual pull-to-refresh
        // bypasses this guard since refreshable's gesture is
        // necessarily slower than the threshold.
        let now = Date()
        if let last = lastLoadAllFiredAt, now.timeIntervalSince(last) < 1.5 {
            return
        }
        lastLoadAllFiredAt = now

        // Reset the loading flag so the placeholder shows on cold start
        // and on .task re-fire after auth flips. `data` is intentionally
        // NOT cleared so a stale-while-revalidate render keeps the page
        // alive during pull-to-refresh.
        await MainActor.run {
            isLoading = true
            loadError = nil
        }

        async let statsTask: Void = loadStats()
        async let meTask: HomepageMeDTO? = {
            do { return try await CardService.shared.fetchHomepageMe() }
            catch { return nil }
        }()
        async let profileTask: PersonalizedProfileResponse? =
            PersonalizationService.shared.fetchProfile()
        async let signalTask = CardService.shared.fetchHomepageSignalBoard()
        // Logger.ui.debug on the catch so a failing fetch leaves a
        // breadcrumb in the Xcode console — silent catch masked total
        // failure as "brief is just empty" before. (See
        // docs/external-api-failure-modes.md.)
        async let briefTask: HomepageAIBriefDTO? = {
            do { return try await CardService.shared.fetchAIBrief() }
            catch { Logger.ui.debug("ai-brief load error: \(error)"); return nil }
        }()
        async let communityTask: HomepageCommunityDTO? = {
            do { return try await CardService.shared.fetchHomepageCommunity() }
            catch { Logger.ui.debug("community load error: \(error)"); return nil }
        }()

        _ = await statsTask
        let me = await meTask
        let profile = await profileTask
        let brief = await briefTask
        let comm = await communityTask

        do {
            let signalBoard = try await signalTask
            await MainActor.run {
                self.data = signalBoard
                self.aiBrief = brief
                self.community = comm
                self.meData = me
                self.styleLabel = profile?.profile?.dominantStyleLabel
                    .flatMap { $0.isEmpty ? nil : $0 }
                self.isLoading = false
            }
        } catch is CancellationError {
            // Cooperative-cancellation error from Swift Concurrency —
            // happens when the Task running loadAll was cancelled
            // (e.g., .task re-fire, view disappear). Not a real
            // failure; the next attempt will set its own loading
            // state. Returning without touching @State leaves
            // isLoading=true so the spinner stays visible until the
            // retry resolves. Real-device 2026-05-06: user reported
            // "failed to load market signals" flashing then data
            // arriving 500ms later — that flash was this catch path
            // setting loadError on what was actually a transient
            // cancellation.
            Logger.ui.debug("loadAll cancelled (Swift Concurrency); leaving spinner")
            return
        } catch let urlError as URLError where urlError.code == .cancelled {
            // URLSession-level cancellation (Code=-999). Same
            // semantics as Swift's CancellationError: a new fetch is
            // taking over, don't surface an error UI.
            Logger.ui.debug("loadAll cancelled (URLSession -999); leaving spinner")
            return
        } catch {
            // Signal board genuinely failed (network, 5xx, etc.) but
            // the AI brief, community, and personal data may still
            // have arrived — render those parts and surface a retry
            // CTA for the movers section.
            await MainActor.run {
                self.aiBrief = brief
                self.community = comm
                self.meData = me
                self.styleLabel = profile?.profile?.dominantStyleLabel
                    .flatMap { $0.isEmpty ? nil : $0 }
                self.loadError = error.localizedDescription
                self.isLoading = false
            }
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
            // Transparent character (no dark tile background) so the
            // mark blends into the homepage chrome instead of looking
            // like a separate floating icon. Slightly larger frame to
            // compensate for the lack of a tile to anchor it visually.
            Image("PopAlphaLogoTransparent")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 30, height: 30)

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
    StatefulMarketplacePreview()
        .preferredColorScheme(.dark)
}

private struct StatefulMarketplacePreview: View {
    @State private var tab: AppTab = .market
    var body: some View {
        MarketplaceView(selectedTab: $tab)
    }
}
