import SwiftUI

// MARK: - Portfolio View

struct PortfolioView: View {
    @State private var holdings: [HoldingRow] = []
    @State private var positions: [Position] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var showAddSheet = false

    private var auth: AuthService { AuthService.shared }

    // MARK: - Summary metrics
    private var totalCostBasis: Double { positions.reduce(0) { $0 + $1.costBasis } }
    private var totalCards: Int { positions.reduce(0) { $0 + $1.totalQty } }
    private var uniqueCards: Int { positions.count }

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                if isLoading && holdings.isEmpty {
                    loadingState
                } else if let error, holdings.isEmpty {
                    errorState(error)
                } else if holdings.isEmpty {
                    emptyState
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
            .task {
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
            VStack(spacing: 20) {
                summarySection
                positionsList
            }
            .padding(.bottom, 32)
        }
    }

    // MARK: - Summary

    private var summarySection: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                summaryCard(title: "Cost Basis", value: "$\(String(format: "%.2f", totalCostBasis))", icon: "dollarsign.circle")
                summaryCard(title: "Cards", value: "\(totalCards)", icon: "rectangle.stack")
                summaryCard(title: "Positions", value: "\(uniqueCards)", icon: "chart.bar")
            }
            .padding(.horizontal, PA.Layout.sectionPadding)
            .padding(.top, 12)
        }
    }

    private func summaryCard(title: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.accent)
                Text(title)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)
        }
        .frame(width: 140, alignment: .leading)
        .padding(16)
        .glassSurface(radius: PA.Layout.panelRadius)
    }

    // MARK: - Positions List

    private var positionsList: some View {
        LazyVStack(spacing: 10) {
            ForEach(positions) { position in
                PortfolioPositionCell(position: position)
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - States

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "rectangle.stack")
                .font(.system(size: 36))
                .foregroundStyle(PA.Colors.accent)
            Text("Sign in to track your collection")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("Add cards to your portfolio and track their value over time.")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            Button { AuthService.shared.signIn() } label: {
                Text("Sign In")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
            }
        }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            Spacer()
            ProgressView().tint(PA.Colors.accent)
            Text("Loading portfolio...").font(PA.Typography.caption).foregroundStyle(PA.Colors.muted)
            Spacer()
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28)).foregroundStyle(PA.Colors.muted)
            Text(message).font(PA.Typography.cardSubtitle).foregroundStyle(PA.Colors.muted)
            Button("Retry") { Task { await loadPortfolio() } }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(PA.Colors.accent)
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "rectangle.stack")
                .font(.system(size: 36)).foregroundStyle(PA.Colors.muted)
            Text("No cards in your collection")
                .font(.system(size: 18, weight: .semibold)).foregroundStyle(PA.Colors.text)
            Text(auth.isAuthenticated
                 ? "Tap + to add your first card."
                 : "Sign in to start tracking your collection and its value over time.")
                .font(PA.Typography.cardSubtitle).foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center).frame(maxWidth: 280)

            if auth.isAuthenticated {
                Button { showAddSheet = true } label: {
                    Text("Add a Card")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PA.Colors.background)
                        .padding(.horizontal, 24).padding(.vertical, 10)
                        .background(PA.Colors.accent).clipShape(Capsule())
                }
            } else {
                Button { AuthService.shared.signIn() } label: {
                    Text("Sign In")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                        .padding(.horizontal, 20).padding(.vertical, 8)
                        .background(PA.Colors.accent.opacity(0.12)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }

    // MARK: - Data

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
            self.error = "Couldn't load portfolio"
        }
        isLoading = false
    }
}
