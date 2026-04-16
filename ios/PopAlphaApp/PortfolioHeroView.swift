import SwiftUI

// MARK: - Portfolio Hero View
// Above-the-fold summary: total value, scrubbable chart, stats.
// The displayed value + change reflects the chart (stock-app pattern):
// - Default: value = today, change = vs first chart point
// - Scrubbing: value = scrubbed point, change = vs first chart point

struct PortfolioHeroView: View {
    let summary: PortfolioSummary
    let handle: String?
    @Binding var selectedWindow: TimeWindow

    @State private var scrubIndex: Int? = nil

    /// Index used for display: scrub position when scrubbing, else the last point.
    private var displayIndex: Int {
        scrubIndex ?? max(0, summary.sparkline.count - 1)
    }

    /// Value to show in the headline.
    private var displayValue: Double {
        guard !summary.sparkline.isEmpty else { return summary.totalValue }
        return summary.sparkline[min(displayIndex, summary.sparkline.count - 1)]
    }

    /// Change from the first chart point to the displayed point.
    /// Falls back to the API-provided summary change when there's no chart.
    private var displayChange: PortfolioChange {
        guard summary.sparkline.count >= 2,
              let first = summary.sparkline.first, first > 0 else {
            return summary.change(for: .day)
        }
        let current = summary.sparkline[min(displayIndex, summary.sparkline.count - 1)]
        let amount = current - first
        let percent = (amount / first) * 100
        return PortfolioChange(amount: amount, percent: percent)
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
                Text(formatValue(displayValue))
                    .font(PA.Typography.heroPrice)
                    .foregroundStyle(PA.Colors.text)
                    .contentTransition(.numericText())
                    .animation(.interactiveSpring(response: 0.15), value: displayValue)

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

            // Premium scrubbable portfolio chart
            if summary.sparkline.count >= 2 {
                PortfolioValueChart(
                    data: summary.sparkline,
                    isPositive: displayChange.isPositive,
                    height: 110,
                    onScrub: { idx in
                        scrubIndex = idx
                    }
                )
                .padding(.horizontal, 4)
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

    private func formatValue(_ value: Double) -> String {
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
