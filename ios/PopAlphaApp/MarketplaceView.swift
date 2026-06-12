import SwiftUI
import OSLog
import Nuke

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
//   4. MarketScanStrip      — slim "Scan a card" reminder (guests only)
//   5. MarketPulseSection   — movers (data-gated)
//   6. SignInPromoCard      — "Make PopAlpha yours" (moved down from top)
//   7. ForYouRail           — falls back to "POPULAR WITH COLLECTORS"
//   8. CommunitySection
//   9. Footer
//
// Section order — authed (signed-in):
//
//   1. TopBar
//   2. PersonalPulseSection — Watchlist · Portfolio · Style chips
//   3. AIBriefCard          — personalized market read
//   4. ForYouRail           — "FOR YOU"
//   5. MarketPulseSection   — movers (data-gated)
//   6. CommunitySection     — "COLLECTORS LIKE YOU" when style known
//   7. Footer
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


    // MARK: Personal context
    @State private var meData: HomepageMeDTO?
    @State private var styleLabel: String?

    // MARK: Signal board data (hoisted from the old SignalBoardView)
    @State private var data: HomepageDataDTO?
    @State private var aiBrief: HomepageAIBriefDTO?
    @State private var jpAIBrief: HomepageAIBriefDTO?
    @State private var community: HomepageCommunityDTO?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var skeletonPulse = false

    // MARK: UI state
    @State private var showSearch = false
    // Default to 7D: the 24H windowed rails (Top Movers / Pullbacks /
    // Momentum) are structurally sparse — change_pct_24h is unpopulated
    // for ~99% of the catalog (tiered refresh → few cards have two
    // consecutive daily points), so the premium 24H "gainer" rail is
    // routinely a lonely 1-card list. 7D has real coverage, so it's the
    // healthier default landing window. Users can still toggle to 24H.
    @State private var selectedWindow: SignalWindow = .d7
    @State private var searchSelectedCard: MarketCard?
    @AppStorage("popalpha.market.hero.dismissed.v1") private var isMarketHeroDismissed = false
    /// Card pushed by tapping a row in ForYou / MarketPulse / Community.
    /// Kept separate from `searchSelectedCard` so the two pipelines
    /// don't fight over the same NavigationStack destination state.
    @State private var selectedCard: MarketCard?
    /// Set pushed by tapping a linkified set name in the AI brief.
    @State private var selectedSetName: String?

    /// Timestamp + auth-state-key for the last loadAll fire.
    /// Together they form a debounce key that suppresses runaway
    /// .task re-fires (the @Observable AuthService cascade caught
    /// 2026-05-05) WITHOUT suppressing legitimate auth-state-change
    /// retries (the cold-launch `nil → user` flip caught 2026-05-06).
    ///
    /// Logic: a new loadAll is debounced only when BOTH the previous
    /// fire was within 1.5s AND the auth state hasn't changed. An
    /// auth flip in the same window bypasses the debounce — that's
    /// exactly the case where we DO want to re-fetch (the previous
    /// fetch went out with the wrong auth state and got cancelled
    /// when SwiftUI's .task(id:) saw the new id).
    @State private var lastLoadAllFiredAt: Date?
    @State private var lastLoadAllAuthState: Bool?

    /// Set when a cancellation catch arm runs. A delayed sentinel
    /// task waits a few seconds and then checks: did data arrive
    /// while we were waiting (i.e., a retry succeeded)? If yes,
    /// great — the sentinel exits silently. If no, we surface a
    /// recoverable error so the user can pull-to-refresh instead
    /// of staring at an infinite spinner. Real-device 2026-05-06:
    /// user waited 30s+ then 15min on a stuck spinner because the
    /// cancellation-suppress fix in 0b92915 left isLoading=true
    /// and the auth-flip retry was being blocked by an over-eager
    /// debounce.
    @State private var cancellationSentinelArmed: Bool = false

    /// Persisted EN/JP market selection. Stored as the raw enum value
    /// so `@AppStorage` can drive a binding directly into the toggle
    /// strip below TopBar. Computed `market` projects to the enum.
    @AppStorage(Market.storageKey) private var marketRaw: String = Market.en.rawValue
    private var market: Market { Market(rawValue: marketRaw) ?? .en }

    /// Warms the OTHER market's rail thumbnails into Nuke's shared
    /// cache (the same pipeline LazyImage reads). The homepage payload
    /// carries both markets' rails in one response, so the EN↔JP
    /// toggle's data is instant — the ~2s of placeholder cards on a
    /// fresh install (owner report 2026-06-12) was purely cold
    /// thumbnail downloads. Held as @State so the prefetcher (a class)
    /// keeps a stable identity across body re-evaluations.
    @State private var offMarketPrefetcher = ImagePrefetcher()

    private func prefetchOffMarketThumbs() {
        guard let payload = data else { return }
        let board = payload.signalBoard
        // The rails the user lands on first after a flip, lead rail
        // first. Both windows for the windowed rails — the 24H/7D
        // toggle shouldn't reintroduce placeholders either — plus the
        // FALLBACK lists MarketPulseSection.cards(for:) can actually
        // render (codex P2 ×2 on PR #256): EN .movers falls back to
        // window-momentum then highConfidenceMovers when the filtered
        // top movers run thin (documented-sparse on 7D), .breakouts
        // falls back to momentum, and .unusual falls back to
        // highConfidenceMovers. A warm-up that skips the fallbacks
        // still shows placeholders exactly when the primary rails are
        // at their sparsest.
        let rails: [[HomepageCardDTO]]
        if market == .jp {
            rails = [
                board.marketWatch ?? [],
                board.topMovers.d7, board.topMovers.h24,
                board.breakouts ?? [],
                board.unusualVolume ?? [],
                board.biggestDrops.d7, board.biggestDrops.h24,
                board.momentum.d7, board.momentum.h24,
                payload.highConfidenceMovers,
                board.midMovers ?? [],
                board.budgetMovers ?? [],
            ]
        } else {
            rails = [
                board.japanese ?? [],
                board.japaneseTopMovers?.d7 ?? [],
                board.japaneseTopMovers?.h24 ?? [],
                board.japaneseBiggestDrops?.d7 ?? [],
                board.japaneseBiggestDrops?.h24 ?? [],
                board.japaneseMomentum?.d7 ?? [],
                board.japaneseMomentum?.h24 ?? [],
                board.japaneseMidMovers ?? [],
                board.japaneseBudgetMovers ?? [],
            ]
        }
        var seen = Set<String>()
        var urls: [URL] = []
        for card in rails.joined() {
            guard
                let raw = card.displayThumbUrl,
                seen.insert(raw).inserted,
                let url = URL(string: raw)
            else { continue }
            urls.append(url)
            // Cap the warm-up: enough to cover everything above the
            // fold on every tab, without slurping the whole catalog.
            if urls.count >= 48 { break }
        }
        guard !urls.isEmpty else { return }
        // Nuke skips anything already cached, so repeat calls (pull-to-
        // refresh, auth flips) only fetch what's actually missing.
        offMarketPrefetcher.startPrefetching(with: urls)
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    // Tighter spacing (was 16) so the first row of the
                    // movers section is visible above the fold on
                    // typical iPhones — the live-market proof should
                    // come into view shortly after the hero / brief.
                    VStack(spacing: 14) {
                        TopBar(showSearch: $showSearch, marketRaw: $marketRaw)
                            .padding(.horizontal, PA.Layout.sectionPadding)
                            .padding(.top, 8)

                        if market == .jp {
                            jpSequence(authed: AuthService.shared.isAuthenticated)
                        } else if AuthService.shared.isAuthenticated {
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
            // Inject the user's selected market into the homepage
            // NavigationStack so homepage subviews that opt into
            // `@Environment(\.market)` reflow in red for JP mode. Scope
            // is deliberate: only this NavigationStack. Settings,
            // CardDetailView, etc. live outside this tree (or in
            // fullScreenCover presentations whose subviews don't read
            // the environment) and remain branded blue.
            .environment(\.market, market)
            .animation(.easeInOut(duration: 0.25), value: market)
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
            .navigationDestination(item: $selectedSetName) { name in
                SetDetailView(setName: name)
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
        if !isMarketHeroDismissed {
            MarketHeroCard(
                onScan: { handleScanCTA() },
                onSeeMovers: { handleSeeMoversCTA(proxy: proxy) },
                onDismiss: { dismissMarketHero() }
            )
            .padding(.horizontal, PA.Layout.sectionPadding)
        }

        // 2. AI Brief — handles its own placeholder when brief is nil.
        AIBriefCard(
            brief: aiBrief,
            fallbackAsOf: data?.asOf,
            styleLabel: styleLabel,
            linkTargets: briefLinkTargets(for: aiBrief),
            onOpenCard: openBriefCard,
            onOpenSet: openBriefSet
        )
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 3. Compact scan strip — a one-tap "Scan a card" nudge for new
        //    collectors who haven't yet internalized the bottom-nav tab
        //    order. Shown to guests (not authed): the audience was flipped
        //    2026-06-12 to match the strip's own discoverability rationale
        //    — new/logged-out users are the ones who benefit from the
        //    reminder; signed-in users already know where Scan lives.
        MarketScanStrip(
            onScan: { handleScanCTA() },
            onSeeMovers: { handleSeeMoversCTA(proxy: proxy) }
        )
        .padding(.horizontal, PA.Layout.sectionPadding)

        // 4. Movers FIRST for guests — they don't have a personalized
        //    profile yet, so the broad market read carries more weight
        //    than a curated rail.
        moversSection

        // 5. Sign-in promo — moved down from the top of screen. By now
        //    the guest has seen the value prop and a market read; the
        //    ask lands as "make this yours" rather than "log in to use
        //    the app."
        SignInPromoCard()
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 6. ForYou rail — eyebrow falls back to "POPULAR WITH COLLECTORS".
        if let data {
            ForYouRail(
                signalBoard: data.signalBoard,
                fallbackWindow: selectedWindow,
                hasProfile: false,
                onSelect: handleSelect
            )
        }

        // 7. Community
        if let community, !(community.trending.isEmpty && community.mostSaved.isEmpty && community.friendsAdded.isEmpty) {
            CommunitySection(data: community, styleLabel: styleLabel)
        }

        // 8. Footer
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
        AIBriefCard(
            brief: aiBrief,
            fallbackAsOf: data?.asOf,
            styleLabel: styleLabel,
            linkTargets: briefLinkTargets(for: aiBrief),
            onOpenCard: openBriefCard,
            onOpenSet: openBriefSet
        )
            .padding(.horizontal, PA.Layout.sectionPadding)

        // 3. ForYou rail — first because the user has a profile.
        if let data {
            ForYouRail(
                signalBoard: data.signalBoard,
                fallbackWindow: selectedWindow,
                hasProfile: styleLabel != nil,
                onSelect: handleSelect
            )
        }

        // 4. Movers
        moversSection

        // 5. Community — eyebrow becomes "COLLECTORS LIKE YOU" when
        //    style label is known (handled inside the section).
        if let community, !(community.trending.isEmpty && community.mostSaved.isEmpty && community.friendsAdded.isEmpty) {
            CommunitySection(data: community, styleLabel: styleLabel)
        }

        // 6. Footer
        if let asOf = data?.asOf {
            footer(asOf: asOf)
        }
    }

    // MARK: - JP market sequence
    //
    // Rendered when the user toggles into JP mode. Intentionally
    // slimmer than the EN sequence: the JP catalog is small (~38
    // cards live, 377 slugs total) and the price-momentum lists
    // (top movers, biggest drops, breakouts) are not yet computed
    // server-side for JP. So instead of showing seven sparse rails
    // we curate the JP view to the single Japanese rail plus the
    // visual chrome that gives users orientation (hero/personal
    // pulse + footer). AI brief, ForYou, Community, and the scan
    // strip are deliberately hidden — they're market-wide today
    // and would leak EN content into a JP view.
    //
    // The `\.market` environment value is injected on the outer
    // NavigationStack (see `body`) so every subview here that
    // reads `@Environment(\.market)` reflows in the Hinomaru red
    // brand. Subviews that don't read the environment (e.g.
    // pushed CardDetailView destinations) stay branded blue.
    @ViewBuilder
    private func jpSequence(authed: Bool) -> some View {
        if authed {
            PersonalPulseSection(me: meData, styleLabel: styleLabel)
                .padding(.horizontal, PA.Layout.sectionPadding)
        } else {
            // JP rail renders directly below the hero, so the secondary
            // "See what's moving" CTA is suppressed — its accessibility
            // hint advertises a scroll that doesn't help in this layout.
            if !isMarketHeroDismissed {
                MarketHeroCard(
                    onScan: { handleScanCTA() },
                    onSeeMovers: nil,
                    onDismiss: { dismissMarketHero() }
                )
                .padding(.horizontal, PA.Layout.sectionPadding)
            }
        }

        // Same slot the EN sequences use, backed by the JP AI Brief
        // cache (/api/homepage/ai-brief?market=JP). Freshness comes
        // from the JP rail itself, not EN's signal-board timestamp.
        AIBriefCard(
            brief: jpAIBrief,
            fallbackAsOf: jpFooterAsOf,
            styleLabel: styleLabel,
            linkTargets: briefLinkTargets(for: jpAIBrief),
            onOpenCard: openBriefCard,
            onOpenSet: openBriefSet
        )
            .padding(.horizontal, PA.Layout.sectionPadding)

        if let data {
            MarketPulseSection(
                selectedWindow: $selectedWindow,
                signalBoard: data.signalBoard,
                highConfidenceMovers: data.highConfidenceMovers,
                watchlistSlugs: watchlistSlugs,
                onSelect: handleSelect,
                japaneseOnly: true
            )
        } else {
            signalPlaceholder
        }

        // JP footer reads freshness from the JP rail itself, not
        // `data.asOf` (which is derived server-side from EN
        // market-pulse / trending candidates and would overstate how
        // current the JP snapshots are). Attribution also swaps to the
        // actual JP data sources. When no JP card carries a usable
        // `updatedAt`, the footer is omitted rather than fabricated.
        if let asOf = jpFooterAsOf {
            footer(asOf: asOf, attribution: "Yahoo Japan & Snkrdunk")
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

    // Skeleton placeholder for the signal rails — a couple of title bars + card
    // rows that gently pulse, so a cold/slow load reads as "content arriving"
    // rather than a bare spinner. Now rarely seen (the homepage precompute makes
    // /api/homepage a ~ms blob read), but it's the honest loading affordance.
    private var loadingState: some View {
        VStack(alignment: .leading, spacing: 28) {
            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 12) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(PA.Colors.muted.opacity(0.18))
                        .frame(width: 150, height: 16)
                    HStack(spacing: 12) {
                        ForEach(0..<3, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: 14)
                                .fill(PA.Colors.muted.opacity(0.12))
                                .frame(width: 132, height: 168)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .opacity(skeletonPulse ? 1.0 : 0.55)
        .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: skeletonPulse)
        .onAppear { skeletonPulse = true }
        .accessibilityLabel("Loading market signals")
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
                    .foregroundStyle(market.accent)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(market.accent.opacity(0.12))
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
    private func footer(asOf: String, attribution: String = "PopAlpha market feeds") -> some View {
        Text("Data as of \(formatAsOf(asOf)) · \(attribution)")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(PA.Colors.muted)
            .padding(.top, 8)
            .frame(maxWidth: .infinity)
    }

    /// Latest `updatedAt` across the JP rail, used as the JP footer's
    /// freshness anchor. Returns nil when the rail is empty or no card
    /// in it carries an `updatedAt` — in that case `jpSequence` omits
    /// the footer entirely rather than show a misleading timestamp.
    /// ISO-8601 strings sort lexicographically the same as
    /// chronologically (assuming UTC + consistent fractional precision),
    /// which both yahoo_jp_card_prices and snkrdunk_card_prices ingest
    /// in.
    private var jpFooterAsOf: String? {
        data?.signalBoard.japanese?
            .compactMap { $0.updatedAt }
            .max()
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

    private func dismissMarketHero() {
        withAnimation(.easeInOut(duration: 0.25)) {
            isMarketHeroDismissed = true
        }
    }

    private func handleSelect(_ card: HomepageCardDTO) {
        PAHaptics.tap()
        selectedCard = card.toMarketCard()
    }

    // MARK: - AI brief deep links
    //
    // Resolve the set/card names the brief may mention against the homepage's
    // already-loaded mover data, so a tapped name routes to a real
    // destination. Only entities present in that data (plus the brief's focus
    // set) become links — anything else stays plain text. `handleBriefLink`
    // in AIBriefCard already fires the haptic.

    private func briefLinkTargets(for brief: HomepageAIBriefDTO?) -> [BriefLinkTarget] {
        var targets: [BriefLinkTarget] = []
        var seenSlugs = Set<String>()
        var seenSets = Set<String>()
        for card in data?.signalBoard.allRailCards ?? [] {
            if seenSlugs.insert(card.slug).inserted {
                targets.append(BriefLinkTarget(name: card.name, kind: .card, slug: card.slug))
            }
            if let set = card.setName, !set.isEmpty, seenSets.insert(set).inserted {
                targets.append(BriefLinkTarget(name: set, kind: .set, slug: set))
            }
        }
        if let focus = brief?.focusSet, !focus.isEmpty, seenSets.insert(focus).inserted {
            targets.append(BriefLinkTarget(name: focus, kind: .set, slug: focus))
        }
        return targets
    }

    private func openBriefCard(_ slug: String) {
        selectedCard = MarketCard.stub(slug: slug)
    }

    private func openBriefSet(_ name: String) {
        selectedSetName = name
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
        // Debounce against runaway .task re-fires (the @Observable
        // cascade caught 2026-05-05) — but ONLY when the auth state
        // is unchanged. An auth-state flip in the same window means
        // SwiftUI's .task(id: isAuthenticated) saw a real id change
        // and cancelled-and-restarted on purpose; that retry must
        // run because the cancelled fetch went out with the wrong
        // auth state. Real-device 2026-05-06: cold launch with
        // restore-from-keychain produced exactly this case (auth
        // flipped nil → user mid-fetch); the previous timestamp-
        // only debounce blocked the legitimate retry and the user
        // saw an infinite spinner.
        let now = Date()
        let currentAuth = AuthService.shared.isAuthenticated
        let withinDebounceWindow = lastLoadAllFiredAt.map { now.timeIntervalSince($0) < 1.5 } ?? false
        let authStateUnchanged = lastLoadAllAuthState == currentAuth
        if withinDebounceWindow && authStateUnchanged {
            return
        }
        lastLoadAllFiredAt = now
        lastLoadAllAuthState = currentAuth

        // Reset the loading flag so the placeholder shows on cold start
        // and on .task re-fire after auth flips. `data` is intentionally
        // NOT cleared so a stale-while-revalidate render keeps the page
        // alive during pull-to-refresh.
        await MainActor.run {
            isLoading = true
            loadError = nil
        }

        async let meTask: HomepageMeDTO? = {
            do { return try await CardService.shared.fetchHomepageMe() }
            catch { return nil }
        }()
        async let profileTask: PersonalizedProfileResponse? =
            PersonalizationService.shared.fetchProfile()
        // Auto-retry the signal board on transient failure (network blip, a cold
        // function) so a flaky first load self-heals instead of dropping the user
        // on the manual retry CTA. Cancellation is re-thrown immediately (never
        // retried) so a legitimate .task re-fire still wins.
        async let signalTask: HomepageDataDTO = {
            var lastError: Error?
            for attempt in 0..<3 {
                do { return try await CardService.shared.fetchHomepageSignalBoard() }
                catch is CancellationError { throw CancellationError() }
                catch let urlError as URLError where urlError.code == .cancelled { throw urlError }
                catch {
                    lastError = error
                    if attempt < 2 {
                        try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 400_000_000)
                    }
                }
            }
            throw lastError ?? URLError(.unknown)
        }()
        // Logger.ui.debug on the catch so a failing fetch leaves a
        // breadcrumb in the Xcode console — silent catch masked total
        // failure as "brief is just empty" before. (See
        // docs/external-api-failure-modes.md.)
        async let briefTask: HomepageAIBriefDTO? = {
            do { return try await CardService.shared.fetchAIBrief(market: .en) }
            catch { Logger.ui.debug("ai-brief load error: \(error)"); return nil }
        }()
        async let jpBriefTask: HomepageAIBriefDTO? = {
            do { return try await CardService.shared.fetchAIBrief(market: .jp) }
            catch { Logger.ui.debug("jp ai-brief load error: \(error)"); return nil }
        }()
        async let communityTask: HomepageCommunityDTO? = {
            do { return try await CardService.shared.fetchHomepageCommunity() }
            catch { Logger.ui.debug("community load error: \(error)"); return nil }
        }()

        let me = await meTask
        let profile = await profileTask
        let brief = await briefTask
        let jpBrief = await jpBriefTask
        let comm = await communityTask

        do {
            let signalBoard = try await signalTask
            await MainActor.run {
                self.data = signalBoard
                self.aiBrief = brief
                self.jpAIBrief = jpBrief
                self.community = comm
                self.meData = me
                self.styleLabel = profile?.profile?.dominantStyleLabel
                    .flatMap { $0.isEmpty ? nil : $0 }
                self.isLoading = false
                // A successful fire short-circuits any pending
                // cancellation sentinel — data arrived, no need for
                // the fallback error.
                self.cancellationSentinelArmed = false
                // Warm the other market's thumbnails now that the rails
                // are known, so the EN↔JP toggle swaps with images
                // already local instead of ~2s of placeholder cards.
                self.prefetchOffMarketThumbs()
            }
        } catch is CancellationError {
            // Cooperative-cancellation error from Swift Concurrency —
            // happens when the Task running loadAll was cancelled
            // (e.g., .task re-fire, view disappear). Don't show an
            // error UI; the next .task fire (auth-flip-driven, since
            // the debounce now permits auth-state changes) takes
            // over the loading state.
            Logger.ui.debug("loadAll cancelled (Swift Concurrency); arming sentinel")
            armCancellationSentinel()
            return
        } catch let urlError as URLError where urlError.code == .cancelled {
            // URLSession-level cancellation (Code=-999). Same
            // semantics as Swift's CancellationError.
            Logger.ui.debug("loadAll cancelled (URLSession -999); arming sentinel")
            armCancellationSentinel()
            return
        } catch {
            // Signal board genuinely failed (network, 5xx, etc.) but
            // the AI brief, community, and personal data may still
            // have arrived — render those parts and surface a retry
            // CTA for the movers section.
            await MainActor.run {
                self.aiBrief = brief
                self.jpAIBrief = jpBrief
                self.community = comm
                self.meData = me
                self.styleLabel = profile?.profile?.dominantStyleLabel
                    .flatMap { $0.isEmpty ? nil : $0 }
                self.loadError = error.localizedDescription
                self.isLoading = false
            }
        }
    }

    /// Fallback for the cancellation arms: if no successful retry
    /// resolves the loading state within `sentinelDelay`, surface a
    /// recoverable error so the user can pull-to-refresh instead of
    /// staring at an infinite spinner.
    ///
    /// Real-device 2026-05-06: user reported sitting on a stuck
    /// spinner for 30s+ after cancellation-suppress (0b92915) left
    /// isLoading=true expecting an auto-retry — but the over-eager
    /// timestamp-only debounce blocked the auth-flip retry that
    /// would have resolved it. Even with the auth-aware debounce
    /// fix, this sentinel is belt-and-braces: any cancellation
    /// path that doesn't get a retry within 3s falls through to
    /// "tap to retry" UX.
    ///
    /// Idempotent — only one sentinel can be armed at a time;
    /// repeated cancellations during the wait don't pile up timers.
    private func armCancellationSentinel() {
        guard !cancellationSentinelArmed else { return }
        cancellationSentinelArmed = true
        Task {
            try? await Task.sleep(for: .seconds(3))
            await MainActor.run {
                // If a retry succeeded while we were sleeping, the
                // success branch will have cleared the sentinel and
                // populated `data`. Don't surface an error in that
                // case. We also don't surface if loadError is
                // already set by a real failure that ran in the
                // meantime — that path has its own retry CTA.
                guard self.cancellationSentinelArmed else { return }
                self.cancellationSentinelArmed = false
                if self.data == nil && self.loadError == nil {
                    self.loadError = "Couldn't load market signals — pull to refresh."
                    self.isLoading = false
                }
            }
        }
    }

}

// MARK: - Top Bar (44pt)

private struct TopBar: View {
    @Binding var showSearch: Bool
    @Binding var marketRaw: String

    var body: some View {
        HStack(spacing: 10) {
            // EN / JP market toggle. Replaces the wide
            // MarketToggleStrip that used to sit in its own row below
            // TopBar — the split row chewed up vertical space that's
            // better spent on hero/brief content. Geometry mimics the
            // Scanner's language pill (28×22 segments, Capsule, 11pt
            // semibold). Active segment fills with `market.accent` —
            // cyan on EN, Hinomaru red on JP — so the pill doubles as
            // a legend.
            marketTogglePill

            // Full modern wordmark. Appearance-aware imageset: black
            // horizontal lockup in light mode (the launch screen's white
            // wordmark was invisible on light chrome), the launch-screen
            // white PNG in dark mode so dark still matches the splash.
            // Rendered raw (no template tint) — the mascot is full-color.
            Image("HeaderLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(height: 26)
                .accessibilityLabel("PopAlpha")

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
                WatchlistView()
            } label: {
                Image(systemName: "heart")
                    .font(.system(size: 13))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(PA.Colors.surfaceSoft)
                    .clipShape(Circle())
            }
            .hapticTap()
            .accessibilityLabel("Watchlist")

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

    @ViewBuilder
    private var marketTogglePill: some View {
        HStack(spacing: 0) {
            marketTogglePillSegment(.en)
            marketTogglePillSegment(.jp)
        }
        .background(PA.Colors.surfaceSoft)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(PA.Colors.borderLight, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Market")
        .accessibilityHint("Switches the homepage between English and Japanese card markets")
    }

    @ViewBuilder
    private func marketTogglePillSegment(_ market: Market) -> some View {
        let isActive = marketRaw == market.rawValue
        // Button (not Text + onTapGesture) so VoiceOver gets standard
        // button control semantics — assistive tech needs to know each
        // segment is an activatable market switch, not just labeled
        // selected text.
        Button {
            guard marketRaw != market.rawValue else { return }
            withAnimation(.easeInOut(duration: 0.25)) {
                marketRaw = market.rawValue
            }
            PAHaptics.selection()
        } label: {
            Text(market.label)
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(isActive ? .white : PA.Colors.textSecondary)
                .frame(width: 32, height: 24)
                .background {
                    if isActive {
                        Capsule().fill(market.accent)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(market.accessibilityLabel)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

#Preview("Marketplace") {
    StatefulMarketplacePreview()
}

private struct StatefulMarketplacePreview: View {
    @State private var tab: AppTab = .market
    var body: some View {
        MarketplaceView(selectedTab: $tab)
    }
}
