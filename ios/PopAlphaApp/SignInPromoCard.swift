import SwiftUI

// MARK: - Sign-In Promo Card
//
// Rich sign-in surface rendered between the market movers and the
// "Popular with collectors" rail in the guest homepage sequence. Replaces
// the slim "Sign in to personalize your feed" banner that used to sit at
// the very top — by the time a guest reads this card they've already
// seen the value prop (hero) and a market read (AI brief + movers), so
// the ask lands as "make this yours" rather than "log in to use the app".
//
// Uses `SignInProviderStack` from ContentView.swift to keep the Google
// and Apple buttons identical to every other sign-in surface in the app.

struct SignInPromoCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 6) {
                Image(systemName: "person.crop.circle.badge.checkmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
                    .accessibilityHidden(true)
                Text("YOUR COLLECTOR PROFILE")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(2.0)
                    .foregroundStyle(PA.Colors.accent)
                    .accessibilityAddTraits(.isHeader)
            }

            Text("Make PopAlpha yours")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(PA.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            Text("Sign in to unlock your collector profile, personalized picks, and AI market alerts.")
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            // Bullet row — short reinforcement of what "yours" means.
            VStack(alignment: .leading, spacing: 6) {
                bulletRow(icon: "scope",          text: "Picks ranked by your style")
                bulletRow(icon: "heart.fill",     text: "Watchlist alerts when prices move")
                bulletRow(icon: "chart.bar.fill", text: "Portfolio P&L and trends")
            }
            .padding(.top, 2)

            // Sign-in buttons — same Google + Apple stack used everywhere
            // else in the app. Centered inside the card.
            HStack {
                Spacer()
                SignInProviderStack(maxWidth: 260)
                Spacer()
            }
            .padding(.top, 4)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(radius: PA.Layout.panelRadius)
    }

    private func bulletRow(icon: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 14)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(PA.Colors.textSecondary)
        }
    }
}

#Preview("Sign-in Promo") {
    SignInPromoCard()
        .padding()
        .background(PA.Colors.background)
        .preferredColorScheme(.dark)
}
