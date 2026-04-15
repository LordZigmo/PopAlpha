import SwiftUI

// MARK: - Marketplace (home screen)
//
// Top-level layout:
//   1. TopBar           (compact 44pt — logo · search · alerts · avatar)
//   2. TodayPulseStrip  (heading · KPIs · global timeframe)
//   3. SignalBoardView  (AI Brief + mover sections, driven by selectedWindow)
//
// The timeframe (24H / 7D) is owned HERE and passed down to SignalBoardView
// as a @Binding so the global control drives every mover section.

struct MarketplaceView: View {
    @State private var pricesRefreshed24h: Int?
    @State private var avgChange24h: Double?
    @State private var marketCap: Double?
    @State private var meData: HomepageMeDTO?
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

                    TodayPulseStrip(
                        pricesRefreshed24h: pricesRefreshed24h,
                        avgChange24h: avgChange24h,
                        marketCap: marketCap,
                        selectedWindow: $selectedWindow
                    )
                    .padding(.horizontal, PA.Layout.sectionPadding)

                    // Your world — between pulse strip and signal board
                    YourWorldSection(data: meData)
                        .padding(.horizontal, PA.Layout.sectionPadding)

                    SignalBoardView(selectedWindow: $selectedWindow)
                }
                .padding(.bottom, 32)
            }
            .background(PA.Colors.background)
            .refreshable {
                await loadAll()
            }
            .task {
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
        }
    }

    // MARK: - Data loaders

    private func loadAll() async {
        async let statsTask: Void = loadStats()
        async let meTask: HomepageMeDTO? = {
            do { return try await CardService.shared.fetchHomepageMe() }
            catch { return nil }
        }()
        _ = await statsTask
        let me = await meTask
        await MainActor.run { meData = me }
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

// MARK: - Today Pulse Strip

private struct TodayPulseStrip: View {
    let pricesRefreshed24h: Int?
    let avgChange24h: Double?
    let marketCap: Double?
    @Binding var selectedWindow: SignalWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Today's Market")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(PA.Colors.text)
                    Text("Live across Pokémon TCG")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
                Spacer()
                GlobalTimeframeControl(selected: $selectedWindow)
            }

            // KPI rail
            HStack(spacing: 18) {
                if let count = pricesRefreshed24h {
                    kpi(label: "Prices 24H", value: formatCount(count))
                }
                if let avg = avgChange24h {
                    kpi(
                        label: "Avg 24H",
                        value: String(format: "%+.1f%%", avg),
                        isPositive: avg >= 0
                    )
                }
                if let cap = marketCap, cap > 0 {
                    kpi(label: "Market cap", value: formatDollar(cap))
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func kpi(label: String, value: String, isPositive: Bool? = nil) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
            Text(value)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(
                    isPositive == true ? PA.Colors.positive :
                    isPositive == false ? PA.Colors.negative :
                    PA.Colors.text
                )
        }
    }

    private func formatDollar(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "$%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "$%.1fK", n / 1_000) }
        return String(format: "$%.0f", n)
    }

    private func formatCount(_ n: Int) -> String {
        if n >= 1000 { return String(format: "%.1fK", Double(n) / 1000) }
        return "\(n)"
    }
}

// MARK: - Global Timeframe Control (24H / 7D)

private struct GlobalTimeframeControl: View {
    @Binding var selected: SignalWindow

    var body: some View {
        HStack(spacing: 0) {
            ForEach(SignalWindow.allCases, id: \.self) { window in
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        selected = window
                        PAHaptics.selection()
                    }
                } label: {
                    Text(window.label)
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1.0)
                        .foregroundStyle(selected == window ? PA.Colors.background : PA.Colors.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background {
                            if selected == window {
                                Capsule().fill(Color.white)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.03)))
        .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1))
    }
}

// MARK: - Your World (personalized section)

private struct YourWorldSection: View {
    let data: HomepageMeDTO?
    private var auth: AuthService { AuthService.shared }

    var body: some View {
        if !auth.isAuthenticated {
            signedOutCard
        } else if let data, (!data.watchlistMovers.isEmpty || data.portfolio != nil) {
            VStack(alignment: .leading, spacing: 12) {
                Text("YOUR WORLD")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(2.0)
                    .foregroundStyle(PA.Colors.accent)

                HStack(spacing: 12) {
                    if !data.watchlistMovers.isEmpty {
                        watchlistCard(data.watchlistMovers)
                    }
                    if let portfolio = data.portfolio {
                        portfolioCard(portfolio)
                    }
                }
            }
        }
        // If authenticated but data is nil/empty, show nothing — the
        // AI Brief and movers fill the space without a distracting
        // empty personalization card.
    }

    // MARK: - Signed-out CTA

    private var signedOutCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("YOUR WORLD")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(PA.Colors.accent)

            VStack(alignment: .leading, spacing: 8) {
                Text("Track what you care about")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
                Text("Sign in to see your watchlist movers and portfolio P&L on the homepage.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .lineLimit(2)

                Button {
                    AuthService.shared.signIn()
                } label: {
                    Text("Sign in")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.background)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(PA.Colors.accent)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSurface(radius: PA.Layout.cardRadius)
        }
    }

    // MARK: - Watchlist card

    private func watchlistCard(_ movers: [WatchlistMoverDTO]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "heart.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(PA.Colors.accent)
                Text("Watchlist")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
            }

            ForEach(movers.prefix(3), id: \.slug) { mover in
                HStack(spacing: 6) {
                    Text(mover.name)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PA.Colors.text)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let pct = mover.changePct {
                        Text(formatChangePct(pct))
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundStyle(pct >= 0 ? PA.Colors.positive : PA.Colors.negative)
                    }
                }
            }

            if movers.count > 3 {
                Text("\(movers.count - 3) more")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 120)
        .glassSurface(radius: PA.Layout.cardRadius)
    }

    // MARK: - Portfolio card

    private func portfolioCard(_ p: PortfolioSummaryDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 10))
                    .foregroundStyle(PA.Colors.accent)
                Text("Portfolio")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
            }

            Text(formatDollar(p.totalMarketValue))
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)

            HStack(spacing: 6) {
                Text(formatPnl(p.dailyPnlAmount))
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(p.dailyPnlAmount >= 0 ? PA.Colors.positive : PA.Colors.negative)
                if let pct = p.dailyPnlPct {
                    Text("(\(formatChangePct(pct)))")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(pct >= 0 ? PA.Colors.positive : PA.Colors.negative)
                }
            }

            Text("\(p.holdingCount) cards")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 120)
        .glassSurface(radius: PA.Layout.cardRadius)
    }

    // MARK: - Formatters

    private func formatChangePct(_ n: Double) -> String {
        let sign = n >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", n))%"
    }

    private func formatDollar(_ n: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: n)) ?? String(format: "$%.0f", n)
    }

    private func formatPnl(_ n: Double) -> String {
        let sign = n >= 0 ? "+" : ""
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 2
        let abs = formatter.string(from: NSNumber(value: abs(n))) ?? String(format: "$%.2f", abs(n))
        return n < 0 ? "-\(abs)" : "\(sign)\(abs)"
    }
}

#Preview("Marketplace") {
    MarketplaceView()
        .preferredColorScheme(.dark)
}
