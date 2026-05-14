import SwiftUI

// MARK: - Market Hero Card
//
// Top-of-screen value-prop card on the Market tab. Answers the three
// questions a new collector asks in the first three seconds:
//
//   1. What is this?       → "The fastest way to understand a Pokémon card."
//   2. Why should I care?  → market value · momentum · style fit
//   3. What should I do?   → "Scan a card"
//
// Renders in two sizes:
//
//   • `MarketHeroCard`   — full hero for guests (replaces the old
//                          "Sign in to personalize" banner that used to
//                          sit at the top of the screen). Big title,
//                          two CTAs, proof row.
//   • `MarketScanStrip`  — slim row for authed users who already see the
//                          tri-stat PersonalPulseSection above. Same two
//                          actions, ~52pt tall.
//
// Both views are stateless — they take two closures from the parent:
//   - `onScan`       → MarketplaceView switches `selectedTab = .scanner`.
//   - `onSeeMovers`  → MarketplaceView scrolls to the MarketPulseSection
//                       anchor via ScrollViewReader.

struct MarketHeroCard: View {
    let onScan: () -> Void
    let onSeeMovers: () -> Void

    /// Homepage market injected by `MarketplaceView`. The hero is pure
    /// brand identity (eyebrow, primary CTA, accent glow, border) so
    /// every accent spot reads from `market.accent` to reflow in red
    /// when the user toggles to JP mode.
    @Environment(\.market) private var market

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Eyebrow: small icon + "PopAlpha" wordmark — orients the
            // card as the app's primary value prop without shouting.
            HStack(spacing: 6) {
                Image(systemName: "viewfinder")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(market.accent)
                    .accessibilityHidden(true)
                Text("POPALPHA")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(2.0)
                    .foregroundStyle(market.accent)
                    .accessibilityAddTraits(.isHeader)
            }

            // Title — sets the value prop in one sentence.
            Text("Understand any Pokémon card in seconds.")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(PA.Colors.text)
                .lineSpacing(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            // Sub — three concrete benefits in one breath.
            Text("Instant price, market signals, and collector-style fit.")
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineSpacing(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            // CTA row. Primary is accent-filled and dominates visually;
            // secondary is a quieter text button at smaller size /
            // muted color so the hero clearly reads "scan first, look
            // at movers second".
            HStack(spacing: 14) {
                Button {
                    onScan()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "viewfinder")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Scan a card")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 11)
                    .background(market.accent)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the scanner so you can identify a card")

                Button {
                    onSeeMovers()
                } label: {
                    HStack(spacing: 4) {
                        Text("See what's moving")
                            .font(.system(size: 13, weight: .medium))
                        Image(systemName: "arrow.down")
                            .font(.system(size: 10, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(PA.Colors.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Scrolls down to the market movers section")

                Spacer(minLength: 0)
            }

            // Proof row — three light-touch credibility chips, separated
            // by middle-dots. Tiny font, muted, sits below the CTAs.
            HStack(spacing: 6) {
                proofChip(icon: "viewfinder", label: "Fast scan")
                Text("·").foregroundStyle(PA.Colors.muted)
                proofChip(icon: "chart.line.uptrend.xyaxis", label: "Live market")
                Text("·").foregroundStyle(PA.Colors.muted)
                proofChip(icon: "scope", label: "Personalized picks")
                Spacer(minLength: 0)
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(PA.Colors.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack {
                PA.Gradients.cardSurface
                // Accent glow on the trailing edge so the card reads as
                // the "scanner" anchor (visually paired with the
                // viewfinder eyebrow on the leading edge). Read lazily
                // from `market.accent` so the gradient re-evaluates
                // when the user toggles markets.
                RadialGradient(
                    colors: [market.accent.opacity(0.16), .clear],
                    center: .topTrailing,
                    startRadius: 0,
                    endRadius: 260
                )
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous)
                .stroke(market.accent.opacity(0.35), lineWidth: 1)
        )
        // VoiceOver reads the title + sub + the two button hints in
        // order, but the chips below are decorative — combine them so
        // they don't read as four separate elements.
        .accessibilityElement(children: .contain)
    }

    private func proofChip(icon: String, label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .accessibilityHidden(true)
            Text(label)
        }
    }
}

// MARK: - Market Scan Strip (authed)
//
// Slim variant rendered between the AI Brief and the For-You rail when
// the user is signed in. Scan stays one tap away even though the user
// already sees the Scan tab in the bottom nav — the expert called this
// out as a discoverability win for new collectors who haven't yet
// internalized the tab order.

struct MarketScanStrip: View {
    let onScan: () -> Void
    let onSeeMovers: () -> Void

    /// Defensive opt-in: MarketScanStrip is hidden in JP mode today,
    /// but reading `\.market` here keeps it correct if it's ever
    /// re-included.
    @Environment(\.market) private var market

    var body: some View {
        HStack(spacing: 10) {
            // Leading icon — viewfinder corner brackets so it reads as
            // "scan" rather than a generic camera glyph.
            ZStack {
                Circle()
                    .fill(market.accent.opacity(0.14))
                    .frame(width: 30, height: 30)
                Image(systemName: "viewfinder")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(market.accent)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text("Scan a card")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                Text("Instant value · momentum · fit")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            // "See what's moving" stays as a text-link so the row reads
            // as "do this primary thing OR jump to movers".
            Button {
                onSeeMovers()
            } label: {
                Text("Movers")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(market.accent)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(market.accent.opacity(0.12))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Scrolls down to the market movers section")

            Button {
                onScan()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "viewfinder")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Scan")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(PA.Colors.background)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(market.accent)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the scanner so you can identify a card")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .glassSurface(radius: PA.Layout.cardRadius)
    }
}

#Preview("Market Hero — guest") {
    MarketHeroCard(onScan: {}, onSeeMovers: {})
        .padding()
        .background(PA.Colors.background)
}

#Preview("Market Scan Strip — authed") {
    MarketScanStrip(onScan: {}, onSeeMovers: {})
        .padding()
        .background(PA.Colors.background)
}
