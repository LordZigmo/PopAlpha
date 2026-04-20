import SwiftUI

// MARK: - Personal Pulse Section
//
// Replaces the old `YourWorldSection`. Sits at the very top of
// MarketplaceView — the *first* thing a collector sees — and answers
// "what's mine today?" before the page shows a single market stat.
//
// Three states, all rendered in the same 1-card footprint so the top of
// the home screen never grows or shrinks between sessions:
//
//   • Guest            → single-line "Sign in to personalize" card with
//                        an inline button. Intentionally small so it
//                        doesn't steal prime real estate from content.
//   • Signed-in, data  → tri-stat row: Watchlist · Portfolio · Style.
//                        Each stat is a compact KPI tile with an eyebrow
//                        label, a primary value, and a secondary line.
//   • Signed-in, empty → same tri-stat row, aspirational empty copy
//                        ("Add a card to start tracking"), no CTA button
//                        (nudge is implicit via Portfolio / Watchlist
//                        tabs). Keeps the card alive without nagging.
//
// Reuses `.glassSurface()`, `PA.Typography`, `PA.Colors.accent`. No new
// visual tokens. The only new moving part is the third chip — the
// personalization style label — which comes from
// `PersonalizationService.fetchProfile()`.

struct PersonalPulseSection: View {
    let me: HomepageMeDTO?
    /// Personalization profile's dominant style label ("Graded PSA Collector",
    /// "Modern Sealed", etc). Nil for guests or profiles that haven't hit
    /// the minimum-event threshold yet. Passed down from MarketplaceView
    /// so the Style chip can render consistently here and in the AI Brief.
    let styleLabel: String?

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        if !auth.isAuthenticated {
            guestCard
        } else {
            authedCard
        }
    }

    // MARK: - Guest state

    private var guestCard: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
            Text("Sign in to personalize your feed")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button {
                AuthService.shared.signIn()
            } label: {
                HStack(spacing: 6) {
                    if auth.isSigningIn {
                        ProgressView()
                            .progressViewStyle(.circular)
                            .controlSize(.mini)
                            .tint(PA.Colors.background)
                    }
                    Text(auth.isSigningIn ? "Signing in…" : "Sign in")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.background)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(PA.Colors.accent.opacity(auth.isSigningIn ? 0.6 : 1.0))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(auth.isSigningIn)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(radius: PA.Layout.cardRadius)
    }

    // MARK: - Authed state

    private var authedCard: some View {
        HStack(spacing: 0) {
            watchlistChip
            divider
            portfolioChip
            divider
            styleChip
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .glassSurface(radius: PA.Layout.cardRadius)
    }

    private var divider: some View {
        Rectangle()
            .fill(PA.Colors.borderLight)
            .frame(width: 1, height: 28)
            .padding(.horizontal, 10)
    }

    // MARK: - Watchlist chip

    @ViewBuilder
    private var watchlistChip: some View {
        let movers = me?.watchlistMovers ?? []
        chip(
            eyebrow: "WATCHLIST",
            icon: "heart.fill",
            primary: movers.isEmpty ? "No movers" : "\(movers.count) moving",
            secondary: watchlistSecondary(movers),
            tone: watchlistTone(movers)
        )
    }

    private func watchlistSecondary(_ movers: [WatchlistMoverDTO]) -> String {
        guard let top = movers.first, let pct = top.changePct else {
            return "Track your first card"
        }
        return "\(top.name) \(formatPct(pct))"
    }

    private func watchlistTone(_ movers: [WatchlistMoverDTO]) -> Color {
        guard let top = movers.first, let pct = top.changePct else {
            return PA.Colors.muted
        }
        return pct >= 0 ? PA.Colors.positive : PA.Colors.negative
    }

    // MARK: - Portfolio chip

    @ViewBuilder
    private var portfolioChip: some View {
        if let p = me?.portfolio {
            chip(
                eyebrow: "PORTFOLIO",
                icon: "rectangle.stack",
                primary: formatDollar(p.totalMarketValue),
                secondary: portfolioSecondary(p),
                tone: p.dailyPnlAmount >= 0 ? PA.Colors.positive : PA.Colors.negative
            )
        } else {
            chip(
                eyebrow: "PORTFOLIO",
                icon: "rectangle.stack",
                primary: "No holdings",
                secondary: "Add a card to track",
                tone: PA.Colors.muted
            )
        }
    }

    private func portfolioSecondary(_ p: PortfolioSummaryDTO) -> String {
        let sign = p.dailyPnlAmount >= 0 ? "+" : "−"
        let amount = formatDollar(abs(p.dailyPnlAmount))
        guard let pct = p.dailyPnlPct else { return "\(sign)\(amount)" }
        return "\(sign)\(amount) (\(formatPct(pct)))"
    }

    // MARK: - Style chip

    @ViewBuilder
    private var styleChip: some View {
        if let styleLabel {
            chip(
                eyebrow: "STYLE",
                icon: "scope",
                primary: styleLabel,
                secondary: "Learned from your taps",
                tone: PA.Colors.accent
            )
        } else {
            chip(
                eyebrow: "STYLE",
                icon: "scope",
                primary: "Learning",
                secondary: "Browse to shape your feed",
                tone: PA.Colors.muted
            )
        }
    }

    // MARK: - Shared chip layout

    private func chip(
        eyebrow: String,
        icon: String,
        primary: String,
        secondary: String,
        tone: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 8, weight: .semibold))
                Text(eyebrow)
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(1.2)
            }
            .foregroundStyle(PA.Colors.accent)

            Text(primary)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(secondary)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(tone)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Formatters (local to avoid coupling with other files)

    private func formatPct(_ n: Double) -> String {
        let sign = n >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", n))%"
    }

    private func formatDollar(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "$%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "$%.1fK", n / 1_000) }
        return String(format: "$%.0f", n)
    }
}

#Preview("Personal Pulse — signed in with data") {
    PersonalPulseSection(
        me: HomepageMeDTO(
            watchlistMovers: [
                WatchlistMoverDTO(
                    slug: "charizard-base-4",
                    name: "Charizard",
                    setName: "Base Set",
                    year: 1999,
                    marketPrice: 480,
                    changePct: 4.2,
                    changeWindow: "24H",
                    imageUrl: nil,
                    marketDirection: "bullish"
                )
            ],
            portfolio: PortfolioSummaryDTO(
                totalMarketValue: 12_340,
                totalCostBasis: 9_800,
                dailyPnlAmount: 142,
                dailyPnlPct: 1.2,
                holdingCount: 23
            )
        ),
        styleLabel: "Graded PSA Collector"
    )
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}

#Preview("Personal Pulse — guest") {
    PersonalPulseSection(me: nil, styleLabel: nil)
        .padding()
        .background(PA.Colors.background)
        .preferredColorScheme(.dark)
}
