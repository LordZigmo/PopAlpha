import SwiftUI
import OSLog

// MARK: - Portfolio View

struct PortfolioView: View {
    @State private var holdings: [HoldingRow] = []
    @State private var positions: [Position] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var showAddSheet = false
    @State private var showImportSheet = false
    @State private var selectedWindow: TimeWindow = .day

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

                if !auth.isAuthenticated {
                    // Unsigned-in users see a fully-rendered demo
                    // portfolio with sample data and a sticky sign-up
                    // CTA. Highest-converting surface in the app.
                    PortfolioDemoView()
                } else if isLoading && holdings.isEmpty {
                    loadingState
                } else if let error, holdings.isEmpty {
                    errorState(error)
                } else if holdings.isEmpty {
                    PortfolioEmptyStateView(onAddCard: { showAddSheet = true })
                } else {
                    portfolioContent
                }
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
                // 1. Your Collector Type — the emotional opener. Lives
                // above the totals so users see *who they are as a
                // collector* before dollar figures.
                if hasFullAnalysis, let identity = overview?.toIdentity() {
                    CollectorIdentityCard(profile: identity)
                }

                // 2. Hero — totals, P&L, sparkline.
                PortfolioHeroView(
                    summary: summary,
                    handle: auth.currentHandle ?? auth.currentFirstName,
                    selectedWindow: $selectedWindow,
                    costBasisGap: costBasisGap
                )

                // 3. Below-threshold users see the unlock progress
                // teaser instead of the analytics sections.
                if !hasFullAnalysis {
                    InsightsUnlockProgress(cardsAdded: positions.count)
                }

                // 4. Radar (separated from the type card) + AI insights.
                // Evolution lives at the bottom of the page.
                if hasFullAnalysis {
                    if let radar = overview?.radarProfile {
                        CollectorRadarCard(profile: radar)
                    }

                    let insights = overview?.toInsights() ?? []
                    if !insights.isEmpty {
                        PortfolioInsightView(
                            insights: insights,
                            activities: [],
                            showActivity: false
                        )
                    }
                }

                // 5. Positions list ("Your Cards"), always shown when
                // there are holdings.
                if !positions.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        positionsHeader
                            .padding(.horizontal, PA.Layout.sectionPadding)

                        Group {
                            switch positionsViewMode {
                            case .list:
                                let descriptors = positionDescriptors
                                LazyVStack(spacing: 10) {
                                    ForEach(positions) { position in
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
                                    ForEach(positions) { position in
                                        PortfolioCardGridCell(
                                            position: position,
                                            metadata: position.canonicalSlug.flatMap { overview?.cardMetadata?[$0] },
                                            onTap: { selectedCard = cardFor(position: position) }
                                        )
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, PA.Layout.sectionPadding)
                    }
                }

                // 6. Evolution timeline — anchored at the bottom of the
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

    private var loadingState: some View {
        VStack(spacing: 12) {
            Spacer()
            ProgressView().tint(PA.Colors.accent)
            Text("Loading portfolio...")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
            Spacer()
        }
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
        .preferredColorScheme(.dark)
}

#Preview("Empty State") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioEmptyStateView()
    }
    .preferredColorScheme(.dark)
}
