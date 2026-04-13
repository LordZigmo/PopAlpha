import SwiftUI

// MARK: - Portfolio Position Cell

struct PortfolioPositionCell: View {
    let position: Position

    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            // Main row
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 12) {
                    // Grade badge
                    Text(position.grade)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(gradeColor)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(gradeColor.opacity(0.15))
                        .clipShape(Capsule())

                    // Card info
                    VStack(alignment: .leading, spacing: 3) {
                        Text(position.canonicalSlug ?? "Unknown Card")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                            .lineLimit(1)

                        Text("\(position.totalQty) card\(position.totalQty == 1 ? "" : "s") · Avg \(position.formattedAvgCost)")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }

                    Spacer()

                    // Cost basis
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(position.formattedCostBasis)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(PA.Colors.text)

                        Text("cost basis")
                            .font(.system(size: 10))
                            .foregroundStyle(PA.Colors.muted)
                    }

                    // Expand chevron
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                }
                .padding(PA.Layout.cardPadding)
            }
            .buttonStyle(.plain)

            // Expanded lots
            if isExpanded && position.lots.count > 1 {
                Divider().background(PA.Colors.border).padding(.horizontal, 16)

                VStack(spacing: 0) {
                    ForEach(position.lots) { lot in
                        lotRow(lot)
                        if lot.id != position.lots.last?.id {
                            Divider().background(PA.Colors.border).padding(.leading, 40)
                        }
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .glassSurface()
    }

    // MARK: - Lot Row

    private func lotRow(_ lot: HoldingRow) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("×\(lot.qty)")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(PA.Colors.text)

                    Text("@ \(lot.formattedCost)")
                        .font(.system(size: 13))
                        .foregroundStyle(PA.Colors.textSecondary)
                }

                HStack(spacing: 8) {
                    if let date = lot.acquiredOn {
                        Text(date)
                            .font(.system(size: 11))
                            .foregroundStyle(PA.Colors.muted)
                    }
                    if let venue = lot.venue {
                        Text(venue)
                            .font(.system(size: 11))
                            .foregroundStyle(PA.Colors.muted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(PA.Colors.surfaceSoft)
                            .clipShape(Capsule())
                    }
                    if let cert = lot.certNumber {
                        Text("PSA #\(cert)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(PA.Colors.accent.opacity(0.8))
                    }
                }
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Grade Color

    private var gradeColor: Color {
        let g = position.grade.uppercased()
        if g.contains("10") { return PA.Colors.gold }
        if g.contains("9") { return PA.Colors.positive }
        if g.contains("8") || g.contains("7") { return PA.Colors.accent }
        return PA.Colors.muted
    }
}
