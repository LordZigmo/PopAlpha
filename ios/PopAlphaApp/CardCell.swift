import SwiftUI

struct CardCell: View {
    let card: MarketCard
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Card image — 63:88 aspect ratio matching the website
            cardImageArea

            // Info below the card image
            cardInfoArea
        }
    }

    // MARK: - Card Image (matches web card-tile-mini)

    private var cardImageArea: some View {
        // Outer wrapper with hover border glow (like web's gradient border)
        ZStack {
            // Glow border (visible on press/hover)
            RoundedRectangle(cornerRadius: PA.Layout.cardRadius + 1, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            PA.Colors.accent.opacity(isHovered ? 0.6 : 0),
                            Color.white.opacity(isHovered ? 0.08 : 0),
                            Color(red: 0.375, green: 0.647, blue: 0.98).opacity(isHovered ? 0.45 : 0)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            // Inner card image container
            cardImage
                .aspectRatio(63.0 / 88.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous))
                .padding(1) // 1px border gap like web
        }
        .aspectRatio(63.0 / 88.0, contentMode: .fit)
    }

    @ViewBuilder
    private var cardImage: some View {
        if let url = card.imageURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .scaleEffect(isHovered ? 1.03 : 1.0)
                        .animation(.easeOut(duration: 0.3), value: isHovered)
                case .failure:
                    cardPlaceholder
                case .empty:
                    cardLoadingState
                @unknown default:
                    cardPlaceholder
                }
            }
        } else {
            cardPlaceholder
        }
    }

    private var cardLoadingState: some View {
        ZStack {
            Color(red: 0.05, green: 0.05, blue: 0.05)

            // Subtle shimmer effect
            LinearGradient(
                colors: card.imageGradient.map {
                    Color(red: $0.r, green: $0.g, blue: $0.b).opacity(0.4)
                },
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            ProgressView()
                .tint(PA.Colors.muted)
        }
    }

    private var cardPlaceholder: some View {
        ZStack {
            // Gradient fallback like the current design
            LinearGradient(
                colors: card.imageGradient.map {
                    Color(red: $0.r, green: $0.g, blue: $0.b)
                },
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            // Radial glow at top like web placeholder
            RadialGradient(
                colors: [Color.white.opacity(0.06), .clear],
                center: .top,
                startRadius: 0,
                endRadius: 200
            )

            VStack(spacing: 6) {
                Image("PopAlphaLogoTransparent")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 36, height: 36)
                    .opacity(0.15)

                Text("No image")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.2))
            }
        }
    }

    // MARK: - Info Area (matches web card-tile-mini layout)

    private var cardInfoArea: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Card name
            Text(card.name)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(2)
                .padding(.top, 12)

            // Set name
            Text(card.setName)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.muted)
                .lineLimit(1)
                .padding(.top, 2)

            // Price + change row
            HStack(alignment: .top, spacing: 8) {
                Text(card.formattedPrice)
                    .font(.system(size: 14, weight: .bold, design: .default))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                Spacer()

                changeBadge
                    .padding(.top, 2)
            }
            .padding(.top, 8)

            // Confidence meter (like web)
            if let level = card.confidenceLabel, let score = card.confidenceScore {
                confidenceMeter(level: level, score: score)
                    .padding(.top, 8)
            }
        }
    }

    // MARK: - Change Badge

    private var changeBadge: some View {
        HStack(spacing: 2) {
            Text(card.changeText)
                .font(.system(size: 11, weight: .semibold))

            Text(card.changeWindow)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(card.isPositive ? PA.Colors.positive.opacity(0.6) : PA.Colors.negative.opacity(0.6))
        }
        .foregroundStyle(card.isPositive ? PA.Colors.positive : PA.Colors.negative)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
            (card.isPositive ? PA.Colors.positive : PA.Colors.negative).opacity(0.1)
        )
        .clipShape(Capsule())
    }

    // MARK: - Confidence Meter (matches web)

    private func confidenceMeter(level: ConfidenceLevel, score: Int) -> some View {
        VStack(spacing: 4) {
            HStack {
                Text("CONFIDENCE")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(Color(white: 0.54))

                Spacer()

                Text("\(level.label) \(score)")
                    .font(.system(size: 11, weight: .semibold, design: .default))
                    .foregroundStyle(confidenceColor(level))
            }

            HStack(spacing: 3) {
                ForEach(0..<4, id: \.self) { index in
                    Capsule()
                        .fill(index < level.segments ? confidenceColor(level) : Color.white.opacity(0.07))
                        .frame(height: 5)
                }
            }
        }
    }

    private func confidenceColor(_ level: ConfidenceLevel) -> Color {
        switch level {
        case .high: return Color(red: 0.388, green: 0.831, blue: 0.443)   // #63D471
        case .solid: return Color(red: 0.49, green: 0.827, blue: 0.988)   // #7DD3FC
        case .watch: return Color(red: 0.98, green: 0.8, blue: 0.082)     // #FACC15
        case .low: return Color(red: 1.0, green: 0.541, blue: 0.502)      // #FF8A80
        }
    }
}

// MARK: - Previews

#Preview("Card Cell - No Image") {
    CardCell(card: MarketCard(
        id: "test",
        name: "Test Card With Long Name",
        setName: "Test Set",
        cardNumber: "#001",
        price: 42.50,
        changePct: -3.2,
        changeWindow: "24H",
        rarity: .rare,
        sparkline: [40, 41, 42, 41.5, 42, 42.5],
        imageGradient: [GradientStop(r: 0.2, g: 0.0, b: 0.1), GradientStop(r: 0.4, g: 0.05, b: 0.2)],
        imageURL: nil,
        confidenceScore: 55
    ))
    .frame(width: 172)
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}
