import SwiftUI

// MARK: - Portfolio View

struct PortfolioView: View {
    @State private var holdings: [HoldingRow] = []
    @State private var positions: [Position] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var showAddSheet = false
    @State private var selectedWindow: TimeWindow = .day
    @State private var portfolioDTO: PortfolioSummaryDTO?

    private var auth: AuthService { AuthService.shared }

    // Real portfolio summary built from live API data + holdings.
    private var summary: PortfolioSummary {
        let rawCount = positions.filter { $0.grade == "RAW" }.reduce(0) { $0 + $1.totalQty }
        let gradedCount = positions.filter { $0.grade != "RAW" }.reduce(0) { $0 + $1.totalQty }
        let costBasis = positions.reduce(0) { $0 + $1.costBasis }
        let totalCards = rawCount + gradedCount

        let totalValue = portfolioDTO?.totalMarketValue ?? costBasis
        let dailyPnl = portfolioDTO.map {
            PortfolioChange(amount: $0.dailyPnlAmount, percent: $0.dailyPnlPct ?? 0)
        } ?? PortfolioChange(amount: 0, percent: 0)

        let aiLine = totalCards > 10
            ? "PopAlpha is analyzing your \(totalCards)-card collection. Collector insights coming soon."
            : "Add more cards to unlock your collector profile and AI-powered insights."

        return PortfolioSummary(
            totalValue: totalValue,
            changes: [
                .day: dailyPnl,
                .week: PortfolioChange(amount: 0, percent: 0),
                .month: PortfolioChange(amount: 0, percent: 0),
            ],
            cardCount: totalCards,
            rawCount: rawCount,
            gradedCount: gradedCount,
            sealedCount: 0,
            sparkline: [],
            aiSummary: aiLine
        )
    }

    // Future: replace with API-driven data from the backend.
    private let identity = CollectorIdentityEngine.analyze(PortfolioMockData.attributesInput)
    private let composition = PortfolioMockData.composition
    private let attributes = PortfolioMockData.attributes
    private let topHoldings = PortfolioMockData.topHoldings
    private let insights = PortfolioMockData.insights
    private let activities = PortfolioMockData.activities

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
                PortfolioHeroView(summary: summary, handle: auth.currentHandle ?? auth.currentFirstName, selectedWindow: $selectedWindow)
                CollectorIdentityCard(profile: identity)
                PortfolioCompositionView(composition: composition, attributes: attributes)
                TopHoldingsView(holdings: topHoldings)
                PortfolioInsightView(insights: insights, activities: activities)
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

        // Non-critical: fetch live market value in background.
        // Runs after isLoading is cleared so it never blocks the UI.
        if let meData = try? await CardService.shared.fetchHomepageMe() {
            portfolioDTO = meData.portfolio
        }
    }
}

// MARK: - Previews

#Preview("Portfolio") {
    PortfolioView()
        .preferredColorScheme(.dark)
}

#Preview("Identity Card") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        CollectorIdentityCard(
            profile: CollectorIdentityEngine.analyze(PortfolioMockData.attributesInput)
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("Empty State") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioEmptyStateView()
    }
    .preferredColorScheme(.dark)
}
