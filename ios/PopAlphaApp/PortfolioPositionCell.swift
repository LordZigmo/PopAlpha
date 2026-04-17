import SwiftUI
import NukeUI

// MARK: - Portfolio Position Cell

struct PortfolioPositionCell: View {
    let position: Position
    var metadata: APICardMetadata? = nil
    var onTap: (() -> Void)? = nil

    @State private var isExpanded = false

    private var displayName: String {
        metadata?.name ?? position.canonicalSlug ?? "Unknown Card"
    }

    private var subtitle: String {
        let qtyLabel = "\(position.totalQty) card\(position.totalQty == 1 ? "" : "s")"
        if let set = metadata?.setName, !set.isEmpty {
            return "\(set) · \(qtyLabel)"
        }
        return "\(qtyLabel) · Avg \(position.formattedAvgCost)"
    }

    private var marketValue: Double? {
        guard let price = metadata?.marketPrice else { return nil }
        return price * Double(position.totalQty)
    }

    var body: some View {
        VStack(spacing: 0) {
            Button {
                onTap?()
            } label: {
                HStack(spacing: 12) {
                    cardThumbnail

                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayName)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                            .lineLimit(1)

                        Text(subtitle)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                            .lineLimit(1)

                        gradeBadge
                            .padding(.top, 2)
                    }

                    Spacer()

                    valueColumn

                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                }
                .padding(PA.Layout.cardPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Multi-lot disclosure (tap to expand below the row)
            if position.lots.count > 1 {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                        Text(isExpanded ? "Hide lots" : "\(position.lots.count) lots")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(PA.Colors.muted)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(PA.Colors.surfaceSoft.opacity(0.4))
                }
                .buttonStyle(.plain)

                if isExpanded {
                    VStack(spacing: 0) {
                        ForEach(position.lots) { lot in
                            lotRow(lot)
                            if lot.id != position.lots.last?.id {
                                Divider().background(PA.Colors.border).padding(.leading, 70)
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
        }
        .glassSurface()
    }

    // MARK: - Card Thumbnail

    private var cardThumbnail: some View {
        Group {
            if let urlString = metadata?.imageUrl, let url = URL(string: urlString) {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        thumbnailPlaceholder
                    }
                }
                .frame(width: 42, height: 58)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
            } else {
                thumbnailPlaceholder
            }
        }
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [PA.Colors.surfaceSoft, PA.Colors.surface],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .frame(width: 42, height: 58)
            .overlay(
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.muted)
            )
    }

    // MARK: - Grade Badge

    private var gradeBadge: some View {
        Text(position.grade)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(gradeColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(gradeColor.opacity(0.15))
            .clipShape(Capsule())
    }

    // MARK: - Value Column

    private var valueColumn: some View {
        VStack(alignment: .trailing, spacing: 3) {
            if let mv = marketValue {
                Text(formatDollar(mv))
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)

                if let chg = metadata?.changePct, chg != 0 {
                    Text(formatPct(chg))
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(chg >= 0 ? PA.Colors.positive : PA.Colors.negative)
                } else {
                    Text("market")
                        .font(.system(size: 10))
                        .foregroundStyle(PA.Colors.muted)
                }
            } else {
                Text(position.formattedCostBasis)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)

                Text("cost basis")
                    .font(.system(size: 10))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
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

    // MARK: - Helpers

    private var gradeColor: Color {
        let g = position.grade.uppercased()
        if g.contains("10") { return PA.Colors.gold }
        if g.contains("9") { return PA.Colors.positive }
        if g.contains("8") || g.contains("7") { return PA.Colors.accent }
        return PA.Colors.muted
    }

    private func formatDollar(_ n: Double) -> String {
        if n >= 1000 { return String(format: "$%.0f", n) }
        return String(format: "$%.2f", n)
    }

    private func formatPct(_ n: Double) -> String {
        let sign = n >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", n))%"
    }
}
