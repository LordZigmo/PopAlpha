import SwiftUI

// MARK: - Portfolio Hero View
// Above-the-fold summary: total value, change toggle, sparkline, stats, AI summary.

struct PortfolioHeroView: View {
    let summary: PortfolioSummary
    let handle: String?
    @Binding var selectedWindow: TimeWindow

    private var change: PortfolioChange { summary.change(for: selectedWindow) }

    /// Show the time-window toggle only when we have data beyond 1D.
    private var hasMultiWindow: Bool {
        [TimeWindow.week, .month].contains { summary.change(for: $0).amount != 0 }
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
                Text(formatValue(summary.totalValue))
                    .font(PA.Typography.heroPrice)
                    .foregroundStyle(PA.Colors.text)

                if change.amount != 0 || change.percent != 0 {
                    HStack(spacing: 6) {
                        Text(formatDelta(change.amount))
                            .font(.system(size: 15, weight: .semibold, design: .rounded))

                        Text("(\(formatPercent(change.percent)))")
                            .font(.system(size: 13, weight: .medium))
                            .opacity(0.8)
                    }
                    .foregroundStyle(change.isPositive ? PA.Colors.positive : PA.Colors.negative)
                }
            }

            // Time window toggle (only when multi-window data is available)
            if hasMultiWindow {
                timeWindowToggle
            }

            // Premium portfolio value chart (only when we have historical data)
            if summary.sparkline.count >= 2 {
                PortfolioValueChart(
                    data: summary.sparkline,
                    isPositive: change.isPositive,
                    height: 110
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

    // MARK: - Time Window Toggle

    private var timeWindowToggle: some View {
        HStack(spacing: 4) {
            ForEach(TimeWindow.allCases) { window in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        selectedWindow = window
                    }
                } label: {
                    Text(window.rawValue)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(selectedWindow == window ? PA.Colors.background : PA.Colors.muted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(selectedWindow == window ? PA.Colors.accent : Color.clear)
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
