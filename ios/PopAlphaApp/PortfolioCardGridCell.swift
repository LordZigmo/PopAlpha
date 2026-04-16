import SwiftUI

// MARK: - Portfolio Card Grid Cell
// Card-focused view of a position: large card image with name, grade,
// and current value below. Used by the "grid" view mode in PortfolioView.

struct PortfolioCardGridCell: View {
    let position: Position
    var metadata: APICardMetadata? = nil
    var onTap: (() -> Void)? = nil

    private var displayName: String {
        metadata?.name ?? position.canonicalSlug ?? "Unknown"
    }

    private var marketValue: Double? {
        guard let price = metadata?.marketPrice else { return nil }
        return price * Double(position.totalQty)
    }

    private var changePct: Double? {
        guard let chg = metadata?.changePct, chg != 0 else { return nil }
        return chg
    }

    var body: some View {
        Button {
            onTap?()
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                cardImage
                infoBlock
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSurface()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Card Image (63:88 standard ratio)

    private var cardImage: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let urlString = metadata?.imageUrl, let url = URL(string: urlString) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        default:
                            imagePlaceholder
                        }
                    }
                } else {
                    imagePlaceholder
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(63.0 / 88.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )

            // Quantity chip if more than 1
            if position.totalQty > 1 {
                Text("×\(position.totalQty)")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.ultraThinMaterial)
                    .clipShape(Capsule())
                    .padding(6)
            }
        }
    }

    private var imagePlaceholder: some View {
        ZStack {
            LinearGradient(
                colors: [PA.Colors.surfaceSoft, PA.Colors.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: "rectangle.stack")
                .font(.system(size: 22))
                .foregroundStyle(PA.Colors.muted)
        }
    }

    // MARK: - Info Block

    private var infoBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)

            HStack(spacing: 6) {
                if let set = metadata?.setName, !set.isEmpty {
                    Text(set)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                gradeBadge
            }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(formatValue())
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)

                if let chg = changePct {
                    Text(formatPct(chg))
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(chg >= 0 ? PA.Colors.positive : PA.Colors.negative)
                } else if marketValue == nil {
                    Text("cost")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
        }
    }

    private var gradeBadge: some View {
        Text(position.grade)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(gradeColor)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(gradeColor.opacity(0.15))
            .clipShape(Capsule())
    }

    // MARK: - Helpers

    private var gradeColor: Color {
        let g = position.grade.uppercased()
        if g.contains("10") { return PA.Colors.gold }
        if g.contains("9") { return PA.Colors.positive }
        if g.contains("8") || g.contains("7") { return PA.Colors.accent }
        return PA.Colors.muted
    }

    private func formatValue() -> String {
        let v = marketValue ?? position.costBasis
        if v >= 1000 { return String(format: "$%.0f", v) }
        return String(format: "$%.2f", v)
    }

    private func formatPct(_ n: Double) -> String {
        let sign = n >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", n))%"
    }
}
