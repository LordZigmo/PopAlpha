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
    @State private var showSearch = false
    @State private var selectedWindow: SignalWindow = .h24

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

                    SignalBoardView(selectedWindow: $selectedWindow)
                }
                .padding(.bottom, 32)
            }
            .background(PA.Colors.background)
            .refreshable {
                await loadStats()
            }
            .task {
                await loadStats()
            }
            .fullScreenCover(isPresented: $showSearch) {
                NavigationStack {
                    SearchView { _ in
                        showSearch = false
                    }
                }
            }
        }
    }

    // MARK: - Stats loader

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

#Preview("Marketplace") {
    MarketplaceView()
        .preferredColorScheme(.dark)
}
