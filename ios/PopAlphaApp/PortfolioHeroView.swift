import SwiftUI

// MARK: - Portfolio Hero View
// Above-the-fold summary: total value, scrubbable chart, stats.
// - Balance / Returns toggle (Vanguard-style) swaps the chart series and headline
// - The displayed value + change reflects the chart's active series:
//     default: value = today, change = vs first chart point
//     scrubbing: value = scrubbed point, change = vs first chart point

private enum ChartMode: String, CaseIterable, Identifiable {
    case balance, returns
    var id: String { rawValue }
    var label: String {
        switch self {
        case .balance: "Balance"
        case .returns: "Returns"
        }
    }
}

struct PortfolioHeroView: View {
    let summary: PortfolioSummary
    let handle: String?
    @Binding var selectedWindow: TimeWindow

    @State private var scrubIndex: Int? = nil
    @State private var chartMode: ChartMode = .balance

    /// Active sparkline depending on mode.
    private var activeSparkline: [Double] {
        switch chartMode {
        case .balance:
            return summary.sparkline
        case .returns:
            return summary.sparkline.map { $0 - summary.totalCostBasis }
        }
    }

    private var displayIndex: Int {
        scrubIndex ?? max(0, activeSparkline.count - 1)
    }

    /// Headline value (currency for balance, signed P&L for returns).
    private var displayValue: Double {
        if !activeSparkline.isEmpty {
            return activeSparkline[min(displayIndex, activeSparkline.count - 1)]
        }
        return chartMode == .balance
            ? summary.totalValue
            : (summary.totalValue - summary.totalCostBasis)
    }

    /// Period change: scrubbed-or-current point minus the first chart point.
    private var displayChange: PortfolioChange {
        guard activeSparkline.count >= 2,
              let first = activeSparkline.first else {
            return summary.change(for: .day)
        }
        let current = activeSparkline[min(displayIndex, activeSparkline.count - 1)]
        let amount = current - first
        // Percent base differs by mode: balance % is over starting balance,
        // returns % uses the starting *balance* so the percentage is interpretable.
        let base: Double
        switch chartMode {
        case .balance:
            base = first > 0 ? first : 1
        case .returns:
            base = (summary.sparkline.first ?? 1) > 0 ? (summary.sparkline.first ?? 1) : 1
        }
        let percent = (amount / base) * 100
        return PortfolioChange(amount: amount, percent: percent)
    }

    /// Line color: in returns mode, sign of current value drives color
    /// (positive returns = green even if dipping). In balance mode, period
    /// direction drives it.
    private var lineIsPositive: Bool {
        switch chartMode {
        case .balance:
            return displayChange.isPositive
        case .returns:
            return displayValue >= 0
        }
    }

    private var rangeLabel: String {
        scrubIndex != nil ? "from start of period" : "Past 30D"
    }

    var body: some View {
        VStack(spacing: 16) {
            // User handle
            if let handle, !handle.isEmpty {
                Text("@\(handle)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }

            // Value + change
            VStack(spacing: 6) {
                Text(formatHeadline(displayValue))
                    .font(PA.Typography.heroPrice)
                    .foregroundStyle(PA.Colors.text)
                    .contentTransition(.numericText())
                    .animation(.interactiveSpring(response: 0.18), value: displayValue)

                let chg = displayChange
                if chg.amount != 0 || chg.percent != 0 {
                    HStack(spacing: 6) {
                        Text(formatDelta(chg.amount))
                            .font(.system(size: 15, weight: .semibold, design: .rounded))

                        Text("(\(formatPercent(chg.percent)))")
                            .font(.system(size: 13, weight: .medium))
                            .opacity(0.85)

                        if !rangeLabel.isEmpty {
                            Text("· \(rangeLabel)")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(PA.Colors.muted)
                        }
                    }
                    .foregroundStyle(chg.isPositive ? PA.Colors.positive : PA.Colors.negative)
                }
            }

            // Balance / Returns segmented control (chart controls)
            modeToggle

            // Premium scrubbable portfolio chart
            if activeSparkline.count >= 2 {
                PortfolioValueChart(
                    data: activeSparkline,
                    isPositive: lineIsPositive,
                    height: 110,
                    onScrub: { idx in
                        scrubIndex = idx
                    }
                )
                .padding(.horizontal, 4)
                .id(chartMode) // Force smooth re-render between modes
                .transition(.opacity)
            }

            // Stats row
            statsRow

            // AI summary (only when populated)
            if !summary.aiSummary.isEmpty {
                Text(summary.aiSummary)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .italic()
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .padding(.horizontal, 8)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
        .padding(.top, 8)
    }

    // MARK: - Mode Toggle

    private var modeToggle: some View {
        HStack(spacing: 4) {
            ForEach(ChartMode.allCases) { mode in
                Button {
                    withAnimation(.easeInOut(duration: 0.22)) {
                        chartMode = mode
                        scrubIndex = nil
                    }
                    PAHaptics.selection()
                } label: {
                    Text(mode.label)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(chartMode == mode ? PA.Colors.background : PA.Colors.textSecondary)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 7)
                        .background(chartMode == mode ? PA.Colors.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(PA.Colors.surfaceSoft)
        .clipShape(Capsule())
    }

    // MARK: - Stats Row

    private var statsRow: some View {
        HStack(spacing: 0) {
            statItem(value: "\(summary.cardCount)", label: "Cards")
            verticalDivider
            statItem(value: "\(summary.rawCount)", label: "Raw")
            verticalDivider
            statItem(value: "\(summary.gradedCount)", label: "Graded")
        }
        .padding(.vertical, 12)
        .glassSurface(radius: PA.Layout.pillRadius)
    }

    private var verticalDivider: some View {
        Rectangle()
            .fill(PA.Colors.border)
            .frame(width: 1, height: 24)
    }

    private func statItem(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)
            Text(label)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Formatting

    /// Headline format: balance shows currency; returns shows signed P&L.
    private func formatHeadline(_ value: Double) -> String {
        switch chartMode {
        case .balance:
            return formatCurrency(value)
        case .returns:
            let sign = value >= 0 ? "+" : "−"
            return "\(sign)\(formatCurrency(abs(value)))"
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = value >= 100 ? 0 : 2
        return formatter.string(from: NSNumber(value: value)) ?? "$\(Int(value))"
    }

    private func formatDelta(_ amount: Double) -> String {
        let sign = amount >= 0 ? "+" : ""
        if abs(amount) >= 100 { return "\(sign)$\(Int(amount))" }
        return "\(sign)$\(String(format: "%.2f", amount))"
    }

    private func formatPercent(_ pct: Double) -> String {
        let sign = pct >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", pct))%"
    }
}
