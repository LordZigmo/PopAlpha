import SwiftUI

// MARK: - Top Holdings View
// Shows the user's most important cards with value, gain/loss, and optional descriptor.

struct TopHoldingsView: View {
    let holdings: [TopHolding]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "trophy.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.accent)
                Text("Top Holdings")
                    .font(PA.Typography.sectionTitle)
                    .foregroundStyle(PA.Colors.text)
            }

            VStack(spacing: 0) {
                ForEach(Array(holdings.enumerated()), id: \.element.id) { index, holding in
                    holdingRow(holding, rank: index + 1)

                    if index < holdings.count - 1 {
                        Divider()
                            .background(PA.Colors.border)
                            .padding(.leading, 64)
                    }
                }
            }
            .glassSurface()
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Holding Row

    private func holdingRow(_ holding: TopHolding, rank: Int) -> some View {
        HStack(spacing: 12) {
            // Card image placeholder
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            holding.accentColor.opacity(0.4),
                            holding.accentColor.opacity(0.15),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 40, height: 56)
                .overlay(
                    Text("#\(rank)")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.6))
                )

            // Card info
            VStack(alignment: .leading, spacing: 3) {
                Text(holding.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                Text(holding.setName)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text(holding.variant)
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(gradeColor(holding.variant))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(gradeColor(holding.variant).opacity(0.12))
                        .clipShape(Capsule())

                    if let desc = holding.descriptor {
                        Text(desc)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(PA.Colors.accent)
                    }
                }
            }

            Spacer()

            // Value
            VStack(alignment: .trailing, spacing: 3) {
                Text(formatValue(holding.currentValue))
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)

                Text(formatChange(holding.changePct))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(holding.changePct >= 0 ? PA.Colors.positive : PA.Colors.negative)
            }
        }
        .padding(PA.Layout.cardPadding)
    }

    // MARK: - Helpers

    private func gradeColor(_ variant: String) -> Color {
        let v = variant.uppercased()
        if v.contains("10") { return PA.Colors.gold }
        if v.contains("9")  { return PA.Colors.positive }
        if v.contains("8") || v.contains("7") { return PA.Colors.accent }
        return PA.Colors.muted
    }

    private func formatValue(_ value: Double) -> String {
        if value >= 1000 { return "$\(String(format: "%.0f", value))" }
        return "$\(String(format: "%.2f", value))"
    }

    private func formatChange(_ pct: Double) -> String {
        let sign = pct >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", pct))%"
    }
}
