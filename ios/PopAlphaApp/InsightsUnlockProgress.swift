import SwiftUI

// MARK: - Insights Unlock Progress
// Shown on the portfolio page while the user has < 3 cards.
// Visualizes their progress toward unlocking AI-powered collector insights.

struct InsightsUnlockProgress: View {
    let cardsAdded: Int
    let target: Int = 3

    private var progress: Double {
        min(Double(cardsAdded) / Double(target), 1.0)
    }

    @State private var animatedProgress: Double = 0

    var body: some View {
        HStack(spacing: 16) {
            // Circular progress ring
            ZStack {
                Circle()
                    .stroke(PA.Colors.surfaceSoft, lineWidth: 5)
                    .frame(width: 56, height: 56)

                Circle()
                    .trim(from: 0, to: animatedProgress)
                    .stroke(
                        AngularGradient(
                            colors: [
                                PA.Colors.accent.opacity(0.5),
                                PA.Colors.accent,
                                PA.Colors.accent,
                            ],
                            center: .center,
                            startAngle: .degrees(-90),
                            endAngle: .degrees(270)
                        ),
                        style: StrokeStyle(lineWidth: 5, lineCap: .round)
                    )
                    .frame(width: 56, height: 56)
                    .rotationEffect(.degrees(-90))
                    .shadow(color: PA.Colors.accent.opacity(0.4), radius: 5)

                Text("\(cardsAdded)/\(target)")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                    .contentTransition(.numericText())
            }

            // Text
            VStack(alignment: .leading, spacing: 3) {
                Text("UNLOCK YOUR COLLECTOR PROFILE")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(PA.Colors.accent)

                Text(remainingMessage)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .lineSpacing(1)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack {
                PA.Gradients.cardSurface
                RadialGradient(
                    colors: [PA.Colors.accent.opacity(0.06), .clear],
                    center: .topLeading,
                    startRadius: 0,
                    endRadius: 180
                )
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous)
                .stroke(
                    LinearGradient(
                        colors: [PA.Colors.accent.opacity(0.2), Color.white.opacity(0.05)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        )
        .padding(.horizontal, PA.Layout.sectionPadding)
        .onAppear {
            withAnimation(.easeOut(duration: 0.9).delay(0.15)) {
                animatedProgress = progress
            }
        }
        .onChange(of: cardsAdded) { _, _ in
            withAnimation(.easeOut(duration: 0.6)) {
                animatedProgress = progress
            }
        }
    }

    private var remainingMessage: String {
        let remaining = target - cardsAdded
        if remaining <= 0 {
            return "Insights unlocked. Pull to refresh."
        }
        if remaining == 1 {
            return "Add 1 more card to unlock your collector type and AI insights."
        }
        return "Add \(remaining) more cards to unlock your collector type and AI insights."
    }
}

#Preview("1 of 3") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        InsightsUnlockProgress(cardsAdded: 1)
    }
    .preferredColorScheme(.dark)
}

#Preview("2 of 3") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        InsightsUnlockProgress(cardsAdded: 2)
    }
    .preferredColorScheme(.dark)
}
