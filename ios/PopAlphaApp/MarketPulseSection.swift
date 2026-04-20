import SwiftUI

// MARK: - Market Pulse Section
//
// Collapses the four previously-stacked MoverSections (Top movers,
// Breakouts, Unusual volume, Pullbacks) into one tabbed module, and
// folds the old TodayPulseStrip KPIs + 24H/7D toggle into its header.
//
// Before (pre-rebalance):
//   [ TodayPulseStrip: title + KPIs + timeframe ]
//   [ Top movers — 1 featured + 4 rows            ]   ~260pt
//   [ Breakouts   — 1 featured + 4 rows            ]   ~260pt
//   [ Unusual     — 1 featured + 4 rows            ]   ~260pt
//   [ Pullbacks   — 1 featured + 4 rows            ]   ~260pt
//
// After (this file):
//   [ KPI microstrip · 24H / 7D toggle        ]
//   [ Movers | Breakouts | Unusual | Pullbacks ]   ← one active at a time
//   [ 1 featured + 4 compact rows              ]
//
// Same data, ~¾ less vertical scroll. No content lost — the inactive
// tabs are one tap away.
//
// Per-row rationale chips are layered on top via MoverSection's
// `watchlistSlugs` + `sectionRationale` knobs so each row communicates
// *why* it's being surfaced: "Watchlist spike" when personal, otherwise
// the section's intent ("Unusual volume", "Thin supply", etc.).

struct MarketPulseSection: View {
    @Binding var selectedWindow: SignalWindow

    let signalBoard: HomepageSignalBoardDTO
    let highConfidenceMovers: [HomepageCardDTO]
    let watchlistSlugs: Set<String>

    // Folded-in KPIs (previously on TodayPulseStrip).
    let pricesRefreshed24h: Int?
    let avgChange24h: Double?
    let marketCap: Double?

    let onSelect: (HomepageCardDTO) -> Void

    enum Category: String, CaseIterable, Identifiable {
        case movers
        case breakouts
        case unusual
        case pullbacks

        var id: String { rawValue }

        var label: String {
            switch self {
            case .movers: return "Movers"
            case .breakouts: return "Breakouts"
            case .unusual: return "Unusual"
            case .pullbacks: return "Pullbacks"
            }
        }

        var eyebrow: String {
            switch self {
            case .movers: return "LIVE MARKET"
            case .breakouts: return "BREAKOUTS"
            case .unusual: return "UNUSUAL"
            case .pullbacks: return "PULLBACKS"
            }
        }

        var title: String {
            switch self {
            case .movers: return "Top movers"
            case .breakouts: return "Breakouts"
            case .unusual: return "Unusual volume"
            case .pullbacks: return "Pullbacks"
            }
        }

        var color: Color {
            switch self {
            case .movers: return PA.Colors.accent
            case .breakouts: return Color(red: 0.486, green: 0.227, blue: 0.929)
            case .unusual: return PA.Colors.gold
            case .pullbacks: return Color(red: 1.0, green: 0.42, blue: 0.42)
            }
        }

        /// Optional section-level rationale. Stamped on every row in
        /// this category unless the row has a watchlist-spike override.
        /// Nil means "let the badge speak for itself".
        var sectionRationale: String? {
            switch self {
            case .movers: return nil
            case .breakouts: return "Thin supply move"
            case .unusual: return "Unusual volume"
            case .pullbacks: return nil
            }
        }

        /// Whether this category respects the global 24H / 7D window.
        /// Breakouts and Unusual are derived from non-windowed signals
        /// server-side today, so the toggle is ignored there.
        var isWindowed: Bool {
            switch self {
            case .movers, .pullbacks: return true
            case .breakouts, .unusual: return false
            }
        }
    }

    @State private var category: Category = .movers

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            headerStrip
            categoryTabs
            activeSection
        }
    }

    // MARK: - Header strip (KPIs + window toggle)

    private var headerStrip: some View {
        HStack(alignment: .center, spacing: 12) {
            HStack(spacing: 14) {
                if let count = pricesRefreshed24h {
                    kpi(label: "Prices 24H", value: formatCount(count))
                }
                if let avg = avgChange24h {
                    kpi(
                        label: "Avg 24H",
                        value: formatSignedPct(avg),
                        tone: avg >= 0 ? PA.Colors.positive : PA.Colors.negative
                    )
                }
                if let cap = marketCap, cap > 0 {
                    kpi(label: "Mkt Cap", value: formatDollar(cap))
                }
            }
            Spacer(minLength: 8)
            if category.isWindowed {
                windowToggle
                    // Only makes sense for windowed categories; hide on
                    // Breakouts / Unusual so it doesn't mislead.
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    private func kpi(label: String, value: String, tone: Color = PA.Colors.text) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
            Text(value)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(tone)
        }
    }

    private var windowToggle: some View {
        HStack(spacing: 0) {
            ForEach(SignalWindow.allCases, id: \.self) { window in
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        selectedWindow = window
                        PAHaptics.selection()
                    }
                } label: {
                    Text(window.label)
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.0)
                        .foregroundStyle(
                            selectedWindow == window
                                ? PA.Colors.background
                                : PA.Colors.textSecondary
                        )
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background {
                            if selectedWindow == window {
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

    // MARK: - Category tabs

    private var categoryTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Category.allCases) { cat in
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            category = cat
                            PAHaptics.selection()
                        }
                    } label: {
                        Text(cat.label)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(
                                category == cat ? cat.color : PA.Colors.textSecondary
                            )
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                Capsule().fill(
                                    category == cat
                                        ? cat.color.opacity(0.14)
                                        : Color.white.opacity(0.03)
                                )
                            )
                            .overlay(
                                Capsule().stroke(
                                    category == cat
                                        ? cat.color.opacity(0.38)
                                        : Color.white.opacity(0.08),
                                    lineWidth: 1
                                )
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, PA.Layout.sectionPadding)
        }
    }

    // MARK: - Active section body

    private var activeSection: some View {
        MoverSection(
            eyebrow: category.eyebrow,
            eyebrowColor: category.color,
            title: category.title,
            window: category.isWindowed ? selectedWindow : nil,
            cards: cards(for: category),
            emptyMessage: emptyMessage(for: category),
            onSelect: onSelect,
            watchlistSlugs: watchlistSlugs,
            sectionRationale: category.sectionRationale
        )
        .id(category)   // ensures fresh transition state when swapping
        .transition(.opacity.combined(with: .move(edge: .trailing)))
    }

    private func cards(for category: Category) -> [HomepageCardDTO] {
        switch category {
        case .movers:
            return signalBoard.topMovers.forWindow(selectedWindow)
        case .breakouts:
            // Prefer Phase 2 dedicated breakouts; fall back to momentum.
            return signalBoard.breakouts
                ?? signalBoard.momentum.forWindow(selectedWindow)
        case .unusual:
            // Prefer Phase 2 unusualVolume; fall back to high-confidence.
            return signalBoard.unusualVolume ?? highConfidenceMovers
        case .pullbacks:
            return signalBoard.biggestDrops.forWindow(selectedWindow)
        }
    }

    private func emptyMessage(for category: Category) -> String {
        switch category {
        case .movers: return "No \(selectedWindow.label) movers yet"
        case .breakouts: return "No breakouts yet"
        case .unusual: return "No unusual activity"
        case .pullbacks: return "No \(selectedWindow.label) pullbacks"
        }
    }

    // MARK: - Formatters

    private func formatDollar(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "$%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "$%.1fK", n / 1_000) }
        return String(format: "$%.0f", n)
    }

    private func formatCount(_ n: Int) -> String {
        if n >= 1000 { return String(format: "%.1fK", Double(n) / 1000) }
        return "\(n)"
    }

    private func formatSignedPct(_ n: Double) -> String {
        String(format: "%+.1f%%", n)
    }
}
