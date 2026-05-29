import SwiftUI
import OSLog

// MARK: - Portfolio View

struct PortfolioView: View {
    @State private var holdings: [HoldingRow] = []
    @State private var positions: [Position] = []
    @State private var isLoading = true
    // Tracks the second-stage enrichment fetch (/api/portfolio/overview).
    // We keep the skeleton up until this completes so cells don't flash
    // raw slug names while waiting for the metadata that turns "charizard-
    // base-set-4" into "Charizard" + image + market price.
    @State private var isOverviewLoading = false
    // One-time first-paint gate. Holds the skeleton up for ~400ms after
    // the view first appears so signed-out users (PortfolioDemoView) and
    // warm-cached signed-in users get a polished crossfade instead of
    // text-and-numbers rendering instantly while card images are still
    // streaming in over the network.
    @State private var initialReveal = false
    @State private var error: String?
    @State private var showAddSheet = false
    @State private var showImportSheet = false
    @State private var selectedWindow: TimeWindow = .day
    @StateObject private var premiumGate = PremiumGate.shared

    // Enriched data from /api/portfolio/overview
    @State private var overview: PortfolioOverviewResponse?
    @State private var activities: [PortfolioActivity] = []

    // Card detail navigation
    @State private var selectedCard: MarketCard?
    // Tapped lot row opens the edit sheet — lets users retroactively
    // add cost basis, bump qty, fix grade, etc. Nil when closed;
    // setting to a HoldingRow auto-presents the sheet.
    @State private var editingLot: HoldingRow?

    // Positions list view mode (table rows vs card grid)
    @State private var positionsViewMode: PositionsViewMode = .list
    // Set to true while a card swipe is in progress so the ScrollView
    // can't scroll vertically at the same time.
    @State private var isSwipingCard = false

    private enum PositionsViewMode { case list, grid }

    private var auth: AuthService { AuthService.shared }

    // Summary built from the overview API response, falling back to holdings data.
    private var summary: PortfolioSummary {
        if let s = overview?.toSummary() { return s }

        let rawCount = positions.filter { $0.grade == "RAW" }.reduce(0) { $0 + $1.totalQty }
        let gradedCount = positions.filter { $0.grade != "RAW" }.reduce(0) { $0 + $1.totalQty }
        let costBasis = positions.reduce(0) { $0 + $1.costBasis }

        return PortfolioSummary(
            totalValue: costBasis,
            totalCostBasis: costBasis,
            changes: [.day: PortfolioChange(amount: 0, percent: 0)],
            cardCount: rawCount + gradedCount,
            rawCount: rawCount,
            gradedCount: gradedCount,
            sealedCount: 0,
            sparkline: [],
            aiSummary: ""
        )
    }

    /// True when the overview API returned full analysis (>= 3 holdings).
    private var hasFullAnalysis: Bool {
        overview?.minimal == false
    }

    /// Per-position accolades — "Largest holding" goes to the position
    /// with the highest market value; "Best performer" goes to the
    /// position with the highest positive 24h change among the rest.
    /// Computed locally from the overview metadata, so we don't need
    /// the deprecated TopHoldings analytics section anymore.
    private var positionDescriptors: [String: String] {
        guard !positions.isEmpty else { return [:] }

        // Score each position by (marketValue, changePct) using overview
        // metadata. Positions without metadata fall back to cost basis
        // for value and 0 for change.
        struct Scored { let id: String; let value: Double; let changePct: Double }
        let scored: [Scored] = positions.map { p in
            let meta = p.canonicalSlug.flatMap { overview?.cardMetadata?[$0] }
            let price = meta?.marketPrice ?? p.avgCost
            return Scored(
                id: p.id,
                value: price * Double(p.totalQty),
                changePct: meta?.changePct ?? 0
            )
        }

        var out: [String: String] = [:]

        // Largest by market value
        if let largest = scored.max(by: { $0.value < $1.value }) {
            out[largest.id] = "Largest holding"

            // Best performer among the remaining positions, only if its
            // change is meaningfully positive (≥ 1%) so we don't
            // mislabel a flat or losing card.
            let rest = scored.filter { $0.id != largest.id }
            if let best = rest.max(by: { $0.changePct < $1.changePct }), best.changePct >= 1.0 {
                out[best.id] = "Best performer"
            }
        }
        return out
    }

    /// Count of positions (grouped holdings) that have at least one lot
    /// with no recorded cost basis. Surfaces as a subtle "X of Y
    /// missing cost basis" badge on the hero so the displayed P&L is
    /// read in the right context. Nil-guard returns no badge when
    /// there are no positions yet.
    private var costBasisGap: CostBasisGap? {
        guard !positions.isEmpty else { return nil }
        let missing = positions.filter { pos in
            pos.lots.contains { $0.pricePaidUsd == nil }
        }.count
        guard missing > 0 else { return nil }
        return CostBasisGap(
            positionsMissingCost: missing,
            totalPositions: positions.count,
        )
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                Group {
                    if showLoadingSkeleton {
                        loadingState
                    } else if !auth.isAuthenticated {
                        // Unsigned-in users see a fully-rendered demo
                        // portfolio with sample data and a sticky sign-up
                        // CTA. Highest-converting surface in the app.
                        PortfolioDemoView()
                    } else if let error, holdings.isEmpty {
                        errorState(error)
                    } else if holdings.isEmpty {
                        PortfolioEmptyStateView(onAddCard: { showAddSheet = true })
                    } else {
                        portfolioContent
                    }
                }
                .transition(.opacity)
                .animation(.easeInOut(duration: 0.25), value: showLoadingSkeleton)
            }
            .navigationTitle("Portfolio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(PA.Colors.surface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                if auth.isAuthenticated {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                showAddSheet = true
                            } label: {
                                Label("Add Card", systemImage: "plus.circle")
                            }
                            Button {
                                showImportSheet = true
                            } label: {
                                Label("Import CSV", systemImage: "square.and.arrow.down")
                            }
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(PA.Colors.background)
                                .frame(width: 30, height: 30)
                                .background(PA.Colors.accent)
                                .clipShape(Circle())
                        }
                        .accessibilityLabel("Add to portfolio")
                        .accessibilityHint("Add a card or import from CSV")
                    }
                }
            }
            .onAppear {
                // Demo-path warm-up. Only runs when signed out — signed-in
                // users with cached data should see content instantly on
                // tab switch, not a synthetic skeleton. .onAppear (rather
                // than .task) so the timer ties to actual tab visibility;
                // TabView can run .task for inactive tabs at parent layout
                // time, which would burn the timer before this tab is ever
                // seen.
                guard !auth.isAuthenticated else { return }
                initialReveal = false
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(600))
                    initialReveal = true
                }
            }
            .task(id: auth.isAuthenticated) {
                await loadPortfolio()
            }
            .refreshable {
                await loadPortfolio()
            }
            .sheet(isPresented: $showAddSheet) {
                AddHoldingSheet {
                    Task { await loadPortfolio() }
                }
            }
            .sheet(isPresented: $showImportSheet) {
                BulkImportSheet {
                    Task { await loadPortfolio() }
                }
            }
            .sheet(item: $editingLot) { lot in
                EditHoldingLotSheet(
                    lot: lot,
                    cardName: lot.canonicalSlug.flatMap { overview?.cardMetadata?[$0]?.name },
                    onSaved: {
                        // Parent-owned dismissal: refresh data first,
                        // then explicitly clear the binding so the
                        // sheet always closes — independent of any
                        // NavigationStack-vs-sheet dismiss quirks.
                        await refreshHoldings()
                        editingLot = nil
                    }
                )
            }
            .navigationDestination(item: $selectedCard) { card in
                CardDetailView(card: card)
            }
        }
    }

    // MARK: - Positions Header (title + view-mode toggle)

    /// Renders the positions in the current view mode (list or grid).
    /// Shared by the flat list and by each raw/graded section.
    @ViewBuilder
    private func positionsBody(_ items: [Position]) -> some View {
        switch positionsViewMode {
        case .list:
            let descriptors = positionDescriptors
            LazyVStack(spacing: 10) {
                ForEach(items) { position in
                    PortfolioPositionCell(
                        position: position,
                        metadata: position.canonicalSlug.flatMap { overview?.cardMetadata?[$0] },
                        descriptor: descriptors[position.id],
                        onTap: { selectedCard = cardFor(position: position) },
                        onLotTap: { lot in editingLot = lot }
                    )
                    .swipeRevealActions(
                        isScrollLocked: $isSwipingCard,
                        onEdit: { editingLot = position.lots.first },
                        onDelete: { Task { await deleteLots(position.lots.map(\.id)) } }
                    )
                }
            }
        case .grid:
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                spacing: 12
            ) {
                ForEach(items) { position in
                    PortfolioCardGridCell(
                        position: position,
                        metadata: position.canonicalSlug.flatMap { overview?.cardMetadata?[$0] },
                        onTap: { selectedCard = cardFor(position: position) }
                    )
                }
            }
        }
    }

    /// A labeled raw/graded section: header with the card count, then the
    /// positions in the current view mode.
    @ViewBuilder
    private func positionsSection(title: String, positions items: [Position]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
                Text("\(items.reduce(0) { $0 + $1.totalQty })")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                Spacer(minLength: 0)
            }
            positionsBody(items)
        }
    }

    private var positionsHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.stack")
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.accent)
                .accessibilityHidden(true)
            Text("Your Cards")
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)
                .accessibilityAddTraits(.isHeader)

            Spacer()

            viewModeToggle
        }
    }

    private var viewModeToggle: some View {
        HStack(spacing: 0) {
            viewModeButton(.list, icon: "list.bullet")
            viewModeButton(.grid, icon: "square.grid.2x2.fill")
        }
        .padding(2)
        .background(PA.Colors.surfaceSoft)
        .clipShape(Capsule())
    }

    private func viewModeButton(_ mode: PositionsViewMode, icon: String) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                positionsViewMode = mode
            }
            PAHaptics.selection()
        } label: {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(positionsViewMode == mode ? PA.Colors.background : PA.Colors.textSecondary)
                .frame(width: 28, height: 22)
                .background(positionsViewMode == mode ? PA.Colors.accent : Color.clear)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// Build a stub MarketCard to navigate to CardDetailView from a position.
    private func cardFor(position: Position) -> MarketCard? {
        guard let slug = position.canonicalSlug else { return nil }
        let meta = overview?.cardMetadata?[slug]
        return MarketCard.stub(
            slug: slug,
            name: meta?.name ?? slug,
            setName: meta?.setName ?? "",
            cardNumber: "",
            imageURL: meta?.imageUrl.flatMap(URL.init(string:))
        )
    }

    // MARK: - Content

    private var portfolioContent: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 28) {
                // 1. Hero — totals, P&L, sparkline.
                PortfolioHeroView(
                    summary: summary,
                    selectedWindow: $selectedWindow,
                    costBasisGap: costBasisGap
                )

                // 2. Below-threshold users see the unlock progress
                // teaser instead of the analytics sections.
                if !hasFullAnalysis {
                    InsightsUnlockProgress(cardsAdded: positions.count)
                }

                // 3. Collector identity + radar + AI insights.
                // Evolution lives at the bottom of the page.
                //
                // Gating layers:
                //   - hasFullAnalysis (>= 3 cards) is the freemium
                //     progression check. < 3 cards renders
                //     InsightsUnlockProgress above; this block doesn't.
                //   - PremiumGate.isPro is the new Pro-tier gate. Free
                //     users WITH 3+ cards see the locked radar teaser
                //     (CollectorRadarLockedCard) but not the AI
                //     insights feed — that's hidden until upgrade.
                if hasFullAnalysis {
                    if premiumGate.isPro {
                        // Identity merges into the radar card's header
                        // for Pro so the type + radar render as a single
                        // screenshot-friendly surface.
                        if let radar = overview?.radarProfile {
                            CollectorRadarCard(
                                profile: radar,
                                identity: overview?.toIdentity(),
                                badges: overview?.badges ?? []
                            )
                        }

                        let insights = overview?.toInsights() ?? []
                        if !insights.isEmpty {
                            PortfolioInsightView(
                                insights: insights,
                                activities: [],
                                showActivity: false
                            )
                        }
                    } else {
                        // Free w/ 3+ cards: identity stays as its own
                        // card above the locked radar teaser. Merging
                        // into the locked variant is a follow-up.
                        if let identity = overview?.toIdentity() {
                            CollectorIdentityCard(profile: identity)
                        }
                        CollectorRadarLockedCard()
                    }
                }

                // 4. Positions list ("Your Cards"), always shown when
                // there are holdings.
                if !positions.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        positionsHeader
                            .padding(.horizontal, PA.Layout.sectionPadding)

                        Group {
                            // Collectors think in raw vs graded — split the
                            // list into labeled sections when the portfolio
                            // holds both, otherwise render a flat list.
                            let rawPositions = positions.filter { $0.grade == "RAW" }
                            let gradedPositions = positions.filter { $0.grade != "RAW" }
                            if !rawPositions.isEmpty && !gradedPositions.isEmpty {
                                VStack(alignment: .leading, spacing: 18) {
                                    positionsSection(title: "Raw", positions: rawPositions)
                                    positionsSection(title: "Graded", positions: gradedPositions)
                                }
                            } else {
                                positionsBody(positions)
                            }
                        }
                        .padding(.horizontal, PA.Layout.sectionPadding)
                    }
                }

                // 5. Evolution timeline — anchored at the bottom of the
                // page so it acts as a "what's been happening" log,
                // not as primary analytics.
                if hasFullAnalysis, !activities.isEmpty {
                    PortfolioInsightView(
                        insights: [],
                        activities: activities,
                        showInsights: false
                    )
                }
            }
            .padding(.bottom, 40)
        }
        .scrollDisabled(isSwipingCard)
    }

    // MARK: - Loading & Error States

    /// True while content shouldn't yet be revealed. Two cases:
    /// 1. Authed cold-load: holdings or first overview is in flight —
    ///    keeps the skeleton up so cells don't flash raw slug names +
    ///    cost-basis fallbacks while waiting for `/api/portfolio/overview`.
    /// 2. Unauthed demo path: brief warm-up window each visit so card
    ///    images have time to populate before the crossfade. Scoped
    ///    behind `!auth.isAuthenticated` so signed-in users with warm
    ///    caches never see this gate on subsequent tab visits.
    private var showLoadingSkeleton: Bool {
        if isLoading && holdings.isEmpty { return true }
        if isOverviewLoading && overview == nil { return true }
        if !auth.isAuthenticated && !initialReveal { return true }
        return false
    }

    private var loadingState: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 28) {
                heroSkeleton
                positionsSkeletonHeader
                gridSkeleton
            }
            .padding(.top, 12)
            .padding(.bottom, 40)
        }
        .scrollDisabled(true)
    }

    // MARK: Skeleton building blocks

    private var heroSkeleton: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Handle/title bar
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 120, height: 12)

            // Big total value
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 200, height: 36)

            // Period change pill
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 140, height: 14)

            // Sparkline area
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(PA.Colors.surfaceSoft.opacity(0.7))
                .frame(height: 80)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface()
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    private var positionsSkeletonHeader: some View {
        HStack {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 90, height: 16)
            Spacer()
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 72, height: 28)
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    private var gridSkeleton: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
            spacing: 12
        ) {
            ForEach(0..<4, id: \.self) { _ in
                gridSkeletonCell
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    /// Mirrors PortfolioCardGridCell's structure (image + 3-row info
    /// block, glassSurface wrap) so the crossfade lands cells in the
    /// same slots they were sketched in.
    private var gridSkeletonCell: some View {
        VStack(alignment: .leading, spacing: 8) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .aspectRatio(63.0 / 88.0, contentMode: .fit)
                .frame(maxWidth: .infinity)

            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                    .frame(height: 13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(PA.Colors.surfaceSoft)
                        .frame(width: 70, height: 10)
                    Spacer()
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(PA.Colors.surfaceSoft)
                        .frame(width: 28, height: 14)
                }
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                    .frame(width: 60, height: 14)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface()
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text(message)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Button("Retry") { Task { await loadPortfolio() } }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
            Spacer()
        }
    }

    // MARK: - Data Loading

    private func loadPortfolio() async {
        guard auth.isAuthenticated else {
            isLoading = false
            return
        }
        isLoading = holdings.isEmpty
        error = nil
        do {
            holdings = try await HoldingsService.shared.fetchHoldings()
            positions = Position.group(holdings)
            // Enter the metadata-loading window BEFORE flipping isLoading
            // off, so the skeleton condition stays true across the
            // transition with no one-frame gap where neither flag is set.
            if !holdings.isEmpty && overview == nil {
                isOverviewLoading = true
            }
        } catch {
            Logger.ui.debug("Holdings fetch failed: \(error)")
            if let apiErr = error as? APIError, case .httpError(403, _) = apiErr {
                self.error = "Set up your profile to access your portfolio"
            } else {
                self.error = "Couldn't load portfolio: \(error.localizedDescription)"
            }
        }
        isLoading = false

        // Non-critical enrichment: overview + activity (don't block UI)
        guard !holdings.isEmpty else { return }

        async let overviewTask: PortfolioOverviewResponse? = {
            try? await APIClient.get(path: "/api/portfolio/overview")
        }()
        async let activityTask: PortfolioActivityResponse? = {
            try? await APIClient.get(path: "/api/portfolio/activity")
        }()

        let fetchedOverview = await overviewTask
        let fetchedActivity = await activityTask

        if let ov = fetchedOverview { overview = ov }
        if let act = fetchedActivity { activities = act.toActivities() }

        isOverviewLoading = false
    }

    // MARK: - Targeted Holdings Refresh

    /// Lightweight refresh that re-fetches only the holdings list and
    /// recomputes positions — without touching overview/activity state.
    /// Used after a single-lot edit so the card row updates in place
    /// without rebuilding the enrichment sections above it (which would
    /// reset the scroll position).
    private func refreshHoldings() async {
        do {
            let fresh = try await HoldingsService.shared.fetchHoldings()
            holdings = fresh
            positions = Position.group(holdings)
        } catch {
            Logger.ui.debug("Holdings refresh failed: \(error)")
        }
    }

    // MARK: - Delete

    /// Remove all lots for the given holding IDs, then optimistically
    /// drop them from local state before the reload confirms it.
    private func deleteLots(_ ids: [String]) async {
        let idSet = Set(ids)
        // Optimistic update — remove from UI immediately
        holdings.removeAll { idSet.contains($0.id) }
        positions = Position.group(holdings)
        PAHaptics.tap()

        do {
            try await HoldingsService.shared.deleteHoldings(ids: ids)
        } catch {
            Logger.ui.debug("Delete failed: \(error)")
        }
        // Reload to sync with server (also triggers overview refresh)
        await loadPortfolio()
    }
}

// MARK: - Previews

#Preview("Portfolio") {
    PortfolioView()
}

#Preview("Empty State") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioEmptyStateView()
    }
}
