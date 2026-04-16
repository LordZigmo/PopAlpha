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

    private var auth: AuthService { AuthService.shared }

    // Summary built from the overview API response, falling back to holdings data.
    private var summary: PortfolioSummary {
        if let s = overview?.toSummary() { return s }

        let rawCount = positions.filter { $0.grade == "RAW" }.reduce(0) { $0 + $1.totalQty }
        let gradedCount = positions.filter { $0.grade != "RAW" }.reduce(0) { $0 + $1.totalQty }
        let costBasis = positions.reduce(0) { $0 + $1.costBasis }

        return PortfolioSummary(
            totalValue: costBasis,
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
        }
    }

    // MARK: - Content

    private var portfolioContent: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 28) {
                PortfolioHeroView(
                    summary: summary,
                    handle: auth.currentHandle ?? auth.currentFirstName,
                    selectedWindow: $selectedWindow
                )

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

                // Positions list (always shown)
                if !positions.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 8) {
                            Image(systemName: "rectangle.stack")
                                .font(.system(size: 14))
                                .foregroundStyle(PA.Colors.accent)
                            Text("All Positions")
                                .font(PA.Typography.sectionTitle)
                                .foregroundStyle(PA.Colors.text)
                        }
                        .padding(.horizontal, PA.Layout.sectionPadding)

                        LazyVStack(spacing: 10) {
                            ForEach(positions) { position in
                                PortfolioPositionCell(position: position)
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
