import SwiftUI

// MARK: - Portfolio Empty State View
// Aspirational empty state that sells the vision of the portfolio page
// before the user has added any cards.

struct PortfolioEmptyStateView: View {
    var onAddCard: (() -> Void)?
    private var auth: AuthService { AuthService.shared }

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            // Icon cluster
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.06))
                    .frame(width: 96, height: 96)

                Circle()
                    .fill(PA.Colors.accent.opacity(0.04))
                    .frame(width: 72, height: 72)

                Image(systemName: "sparkles")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(PA.Colors.accent)
            }

            // Headline + body
            VStack(spacing: 10) {
                Text("Your collector identity\nawaits")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
                    .multilineTextAlignment(.center)

                Text("Add cards to your portfolio and PopAlpha will identify your collector type, surface insights, and track your collection\u{2019}s evolution over time.")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(maxWidth: 300)
            }

            // Feature previews
            VStack(spacing: 8) {
                featureRow(icon: "person.text.rectangle",  text: "Collector type identification")
                featureRow(icon: "chart.bar.fill",         text: "Portfolio composition breakdown")
                featureRow(icon: "brain.head.profile",     text: "AI-powered collection insights")
                featureRow(icon: "arrow.triangle.branch",  text: "Behavior evolution tracking")
            }
            .padding(.horizontal, 40)

            // CTA
            if auth.isAuthenticated {
                Button { onAddCard?() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Add Your First Card")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 28)
                    .padding(.vertical, 13)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
                }
            } else {
                Button { AuthService.shared.signIn() } label: {
                    Text("Sign In to Start")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                        .padding(.horizontal, 28)
                        .padding(.vertical, 13)
                        .background(PA.Colors.accent.opacity(0.12))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }

            Spacer()
            Spacer()
        }
    }

    private func featureRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 20)

            Text(text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(PA.Colors.textSecondary)

            Spacer()
        }
    }
}
