import SwiftUI

// MARK: - Portfolio Hero View
// Above-the-fold summary: total value, scrubbable chart, stats.
// One clear portfolio-value chart (price-over-time, weighted by your
// holdings). Headline value + change track the chart in real time —
// drag to scrub through any day in the past 30.

/// Cost-basis completeness signal shown below the hero stats so the
/// P&L number is honest. Nil means "don't render the badge".
struct CostBasisGap: Equatable {
    let positionsMissingCost: Int
    let totalPositions: Int
}

struct PortfolioHeroView: View {
    let summary: PortfolioSummary
    let handle: String?
    @Binding var selectedWindow: TimeWindow
    var costBasisGap: CostBasisGap? = nil

    @State private var scrubIndex: Int? = nil

    private var sparkline: [Double] { summary.sparkline }

    private var displayIndex: Int {
        scrubIndex ?? max(0, sparkline.count - 1)
    }

    private var displayValue: Double {
        guard !sparkline.isEmpty else { return summary.totalValue }
        return sparkline[min(displayIndex, sparkline.count - 1)]
    }

    /// Period change: scrubbed-or-current point minus the first chart point.
    private var displayChange: PortfolioChange {
        guard sparkline.count >= 2,
              let first = sparkline.first, first > 0 else {
            return summary.change(for: .day)
        }
        let current = sparkline[min(displayIndex, sparkline.count - 1)]
        let amount = current - first
        let percent = (amount / first) * 100
        return PortfolioChange(amount: amount, percent: percent)
    }

    private var rangeLabel: String {
        scrubIndex != nil ? "vs start of period" : "Past 30D"
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
                Text(formatCurrency(displayValue))
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

            // Premium scrubbable portfolio-value chart
            if sparkline.count >= 2 {
                PortfolioValueChart(
                    data: sparkline,
                    isPositive: displayChange.isPositive,
                    height: 130,
                    onScrub: { idx in
                        scrubIndex = idx
                    }
                )
                .padding(.horizontal, 4)
            }

            // Stats row
            statsRow

            // Honest P&L disclosure: when some positions are missing
            // cost basis, surface a subtle badge so the change number
            // above isn't misread as a full-portfolio P&L.
            if let gap = costBasisGap, gap.positionsMissingCost > 0 {
                costBasisBadge(gap)
            }

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

    // MARK: - Cost-basis completeness badge

    private func costBasisBadge(_ gap: CostBasisGap) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .font(.system(size: 10, weight: .semibold))
            Text("\(gap.positionsMissingCost) of \(gap.totalPositions) positions missing cost basis")
                .font(PA.Typography.caption)
            Text("· P&L is partial")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted.opacity(0.8))
        }
        .foregroundStyle(PA.Colors.muted)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(PA.Colors.surfaceSoft.opacity(0.5))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(PA.Colors.borderLight, lineWidth: 0.5)
        )
    }

    // MARK: - Formatting

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
