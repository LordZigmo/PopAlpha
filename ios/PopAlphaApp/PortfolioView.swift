import SwiftUI

// MARK: - Portfolio View

struct PortfolioView: View {
    @State private var holdings: [HoldingRow] = []
    @State private var positions: [Position] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var showAddSheet = false
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

                if isLoading && holdings.isEmpty {
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
                        Button {
                            showAddSheet = true
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(PA.Colors.background)
                                .frame(width: 30, height: 30)
                                .background(PA.Colors.accent)
                                .clipShape(Circle())
                        }
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
            .sheet(item: $editingLot) { lot in
                EditHoldingLotSheet(
                    lot: lot,
                    cardName: lot.canonicalSlug.flatMap { overview?.cardMetadata?[$0]?.name },
                    onSaved: {
                        Task { await loadPortfolio() }
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
            Text("Your Cards")
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)

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
                PortfolioHeroView(
                    summary: summary,
                    handle: auth.currentHandle ?? auth.currentFirstName,
                    selectedWindow: $selectedWindow,
                    costBasisGap: costBasisGap
                )

                // While the user hasn't reached the analysis threshold,
                // show a premium progress card instead of mock sections.
                if !hasFullAnalysis {
                    InsightsUnlockProgress(cardsAdded: positions.count)
                }

                // Enriched sections (only when backend returned full analysis)
                if hasFullAnalysis {
                    if let identity = overview?.toIdentity() {
                        CollectorIdentityCard(profile: identity)
                    }

                    if let composition = overview?.toComposition() {
                        let attrs = overview?.toAttributes() ?? []
                        PortfolioCompositionView(composition: composition, attributes: attrs)
                    }

                    let topHoldings = overview?.toTopHoldings() ?? []
                    if !topHoldings.isEmpty {
                        TopHoldingsView(holdings: topHoldings)
                    }

                    let insights = overview?.toInsights() ?? []
                    if !insights.isEmpty || !activities.isEmpty {
                        PortfolioInsightView(insights: insights, activities: activities)
                    }
                }

                // Positions list (always shown when there are holdings)
                if !positions.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        positionsHeader
                            .padding(.horizontal, PA.Layout.sectionPadding)

                        Group {
                            switch positionsViewMode {
                            case .list:
                                LazyVStack(spacing: 10) {
                                    ForEach(positions) { position in
                                        PortfolioPositionCell(
                                            position: position,
                                            metadata: position.canonicalSlug.flatMap { overview?.cardMetadata?[$0] },
                                            onTap: { selectedCard = cardFor(position: position) },
                                            onLotTap: { lot in editingLot = lot }
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
            }
            .padding(.bottom, 40)
        }
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
            print("[PortfolioView] Holdings fetch failed: \(error)")
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
