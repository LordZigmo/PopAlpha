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

    /// When true, this section is the JP-market homepage's sole
    /// content surface: the category tab bar is suppressed, the KPI
    /// microstrip is hidden (those numbers describe the EN catalog),
    /// the 24H/7D window toggle is hidden, and the body renders the
    /// `.japanese` rail directly. Defaults to false so every existing
    /// call site keeps the historical multi-tab behavior.
    var japaneseOnly: Bool = false

    /// Homepage market injected by `MarketplaceView`. Used only for
    /// brand-identity color swaps (the "LIVE MARKET" eyebrow on the
    /// Movers tab in EN; the active tab fill when that tab is also
    /// the Movers tab). Per-category colors and semantic colors
    /// (positive/negative/gold) are untouched.
    @Environment(\.market) private var market

    enum Category: String, CaseIterable, Identifiable {
        case movers
        case breakouts
        case unusual
        case pullbacks
        case mid
        case budget
        case japanese

        var id: String { rawValue }

        var label: String {
            switch self {
            case .movers: return "Movers"
            case .breakouts: return "Breakouts"
            case .unusual: return "Unusual"
            case .pullbacks: return "Pullbacks"
            case .mid: return "Mid"
            case .budget: return "Budget"
            case .japanese: return "Japan"
            }
        }

        var eyebrow: String {
            switch self {
            // Server tiers: premium ≥ $50, mid $8–$50, budget $1–$8
            // (migration 20260504230000_compute_daily_top_movers_mid_tier.sql)
            case .movers: return "LIVE MARKET"
            case .breakouts: return "BREAKOUTS"
            case .unusual: return "UNUSUAL"
            case .pullbacks: return "PULLBACKS"
            case .mid: return "$8–$50"
            case .budget: return "UNDER $8"
            case .japanese: return "JAPAN"
            }
        }

        var title: String {
            switch self {
            case .movers: return "Top Movers"
            case .breakouts: return "Breakouts"
            case .unusual: return "Unusual Volume"
            case .pullbacks: return "Pullbacks"
            case .mid: return "Mid Movers"
            case .budget: return "Budget Movers"
            case .japanese: return "Japanese Cards"
            }
        }

        var color: Color {
            switch self {
            case .movers: return PA.Colors.accent
            case .breakouts: return Color(red: 0.486, green: 0.227, blue: 0.929)
            case .unusual: return PA.Colors.gold
            case .pullbacks: return Color(red: 1.0, green: 0.42, blue: 0.42)
            case .mid: return Color(red: 0.063, green: 0.725, blue: 0.506) // emerald-500
            case .budget: return Color(red: 0.961, green: 0.620, blue: 0.043) // amber-500
            case .japanese: return Color(red: 0.973, green: 0.443, blue: 0.443) // matches web rail #F87171
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
            case .mid: return nil
            case .budget: return nil
            case .japanese: return nil
            }
        }

        /// Whether this category respects the global 24H / 7D window.
        /// Breakouts, Unusual, Mid, Budget, and Japanese come from
        /// non-windowed daily-computed (or discovery-sorted) lists
        /// server-side, so the toggle is ignored there.
        var isWindowed: Bool {
            switch self {
            case .movers, .pullbacks: return true
            case .breakouts, .unusual, .mid, .budget, .japanese: return false
            }
        }
    }

    @State private var category: Category = .movers

    /// Categories shown in the tab strip. In JP-only mode the tab
    /// strip is hidden entirely (the section already knows it's
    /// rendering `.japanese`). In EN mode the `.japanese` tab is
    /// hidden — JP is now its own top-level market, so a JP tab
    /// inside the EN view would be redundant. The case itself stays
    /// in the enum so JP-only mode reuses all the existing wiring
    /// (`title`, `eyebrow`, `cards(for:)`, etc.) without duplication.
    private var visibleCategories: [Category] {
        japaneseOnly ? [.japanese] : Category.allCases.filter { $0 != .japanese }
    }

    /// The category whose rail is currently rendered. JP-only mode
    /// forces `.japanese`; EN mode honours the user's tab selection.
    private var activeCategory: Category {
        japaneseOnly ? .japanese : category
    }

    /// Brand-aware accent for a given category. Only the Movers tab
    /// uses brand identity (`PA.Colors.accent`); every other category
    /// keeps its own semantic palette. When the homepage is in JP
    /// mode, the Movers brand spot flips to Hinomaru red via the
    /// `\.market` environment — but JP mode never renders the Movers
    /// tab today, so this swap is currently defensive.
    private func brandedColor(_ category: Category) -> Color {
        category == .movers ? market.accent : category.color
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !japaneseOnly {
                headerStrip
                categoryTabs
            }
            activeSection
        }
    }

    // MARK: - Header strip (KPIs)
    //
    // The 24H / 7D window toggle used to live on the right side of this
    // strip; it now sits inline with the section title (see
    // `activeSection`) so the control is directly adjacent to the data
    // it switches. The KPIs alone fill this row.

    private var headerStrip: some View {
        HStack(spacing: 14) {
            // Friendlier labels — the old "Prices 24H" / "Mkt Cap"
            // read like a Bloomberg ticker; collectors who don't
            // come from finance bounced off them. Same numbers,
            // plain English.
            if let count = pricesRefreshed24h {
                kpi(label: "Cards tracked 24H", value: formatCount(count))
            }
            if let avg = avgChange24h {
                kpi(
                    label: "Avg change 24H",
                    value: formatSignedPct(avg),
                    tone: avg >= 0 ? PA.Colors.positive : PA.Colors.negative
                )
            }
            if let cap = marketCap, cap > 0 {
                kpi(label: "Tracked market cap", value: formatDollar(cap))
            }
            Spacer(minLength: 0)
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
                                // PA.Colors.text adapts: white in dark mode,
                                // near-black in light mode. Paired with the
                                // text foregroundStyle of PA.Colors.background
                                // above, the selected pill stays high-contrast
                                // in both modes.
                                Capsule().fill(PA.Colors.text)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(PA.Colors.hairline(0.03)))
        .overlay(Capsule().stroke(PA.Colors.hairline(0.08), lineWidth: 1))
    }

    // MARK: - Category tabs

    private var categoryTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(visibleCategories) { cat in
                    let tabColor = brandedColor(cat)
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            category = cat
                            PAHaptics.selection()
                        }
                    } label: {
                        Text(cat.label)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(
                                category == cat ? tabColor : PA.Colors.textSecondary
                            )
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                Capsule().fill(
                                    category == cat
                                        ? tabColor.opacity(0.14)
                                        : PA.Colors.hairline(0.03)
                                )
                            )
                            .overlay(
                                Capsule().stroke(
                                    category == cat
                                        ? tabColor.opacity(0.38)
                                        : PA.Colors.hairline(0.08),
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
        let cat = activeCategory
        return MoverSection(
            eyebrow: cat.eyebrow,
            eyebrowColor: brandedColor(cat),
            title: cat.title,
            window: cat.isWindowed ? selectedWindow : nil,
            cards: cards(for: cat),
            emptyMessage: emptyMessage(for: cat),
            onSelect: onSelect,
            watchlistSlugs: watchlistSlugs,
            sectionRationale: cat.sectionRationale,
            trailingAccessory: {
                // Window toggle sits inline with the section title for
                // windowed categories (Movers, Pullbacks). Non-windowed
                // tabs (Breakouts, Unusual, Mid, Budget, Japanese) come
                // from pre-computed daily lists and ignore the toggle,
                // so we hide it there. JP-only mode also suppresses it
                // implicitly since `.japanese` is non-windowed.
                if cat.isWindowed && !japaneseOnly {
                    windowToggle
                        .transition(.opacity)
                }
            }
        )
        .id(cat)   // ensures fresh transition state when swapping
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
        case .mid:
            // Older server builds (pre 20260504230000_compute_daily_top_movers_mid_tier)
            // may not include midMovers; fall back to empty (renders the empty state).
            return signalBoard.midMovers ?? []
        case .budget:
            return signalBoard.budgetMovers ?? []
        case .japanese:
            // Older server builds (pre 2026-05-07 JP onboarding) won't
            // include the japanese rail; fall back to empty so the tab
            // still renders gracefully.
            //
            // Each JP card is run through `preferringJpSource()` so the
            // tile shows the Yahoo!JP or Snkrdunk native price (when a
            // source qualifies on sample count) instead of Scrydex's
            // USD reflection. This is what the JP-market toggle
            // actually promises to the user — without it the JP view
            // is just a colored shell over the same Scrydex data the
            // EN view shows.
            return (signalBoard.japanese ?? []).map { $0.preferringJpSource() }
        }
    }

    private func emptyMessage(for category: Category) -> String {
        switch category {
        case .movers: return "No \(selectedWindow.label) movers yet"
        case .breakouts: return "No breakouts yet"
        case .unusual: return "No unusual activity"
        case .pullbacks: return "No \(selectedWindow.label) pullbacks"
        case .mid: return "No mid movers yet"
        case .budget: return "No budget movers yet"
        case .japanese: return "No Japanese cards yet"
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
