import SwiftUI

// MARK: - Collector Identity Card
// The emotional centerpiece of the portfolio page. Differentiated from other
// cards via a subtle accent-tinted gradient border and corner glow.

struct CollectorIdentityCard: View {
    let profile: CollectorIdentityProfile

    /// Traits live inside a dropdown row at the bottom of the card so
    /// the type + explanation read clean by default. Tap the row to
    /// reveal the secondary archetypes a user also shows traits of.
    @State private var traitsExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            headerRow
            explanationText
            if !profile.traits.isEmpty { traitsDropdown }
        }
        .padding(20)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(accentBorder)
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.12))
                    .frame(width: 44, height: 44)
                Image(systemName: profile.primaryType.icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("YOUR COLLECTOR TYPE")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                    .tracking(0.8)

                Text(profile.primaryType.rawValue)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
            }

            Spacer()

            confidenceMeter
        }
    }

    // MARK: - Explanation

    private var explanationText: some View {
        Text(profile.explanation)
            .font(.system(size: 14))
            .foregroundStyle(PA.Colors.textSecondary)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Traits Dropdown
    // Collapsible row attached to the bottom of the card. The trigger
    // header is always visible; the trait pills slide in/out on tap.

    private var traitsDropdown: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().background(PA.Colors.border)

            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    traitsExpanded.toggle()
                }
                PAHaptics.selection()
            } label: {
                HStack(spacing: 6) {
                    Text("Also shows traits of")
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)

                    Text("\(profile.traits.count)")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(PA.Colors.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(PA.Colors.accent.opacity(0.12))
                        .clipShape(Capsule())

                    Spacer()

                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                        .rotationEffect(.degrees(traitsExpanded ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if traitsExpanded {
                HStack(spacing: 8) {
                    ForEach(profile.traits) { trait in
                        traitPill(trait)
                    }
                    Spacer(minLength: 0)
                }
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .move(edge: .top)),
                    removal: .opacity
                ))
            }
        }
    }

    private func traitPill(_ trait: CollectorTrait) -> some View {
        HStack(spacing: 4) {
            Image(systemName: trait.type.icon)
                .font(.system(size: 9))
            Text(trait.type.rawValue)
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(PA.Colors.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(PA.Colors.surfaceSoft)
        .clipShape(Capsule())
    }

    // MARK: - Confidence Meter

    private var confidenceMeter: some View {
        VStack(spacing: 3) {
            Text("\(Int(profile.confidence * 100))%")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.accent)

            HStack(spacing: 2) {
                ForEach(0..<5, id: \.self) { i in
                    let threshold = Double(i + 1) / 5.0
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(profile.confidence >= threshold ? PA.Colors.accent : PA.Colors.surfaceSoft)
                        .frame(width: 6, height: 3)
                }
            }
        }
    }

    // MARK: - Background + Border

    private var cardBackground: some View {
        ZStack {
            PA.Gradients.cardSurface
            RadialGradient(
                colors: [PA.Colors.accent.opacity(0.06), .clear],
                center: .topLeading,
                startRadius: 0,
                endRadius: 200
            )
        }
    }

    private var accentBorder: some View {
        RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous)
            .stroke(
                LinearGradient(
                    colors: [
                        PA.Colors.accent.opacity(0.2),
                        PA.Colors.accent.opacity(0.05),
                        Color.white.opacity(0.03),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                lineWidth: 1
            )
    }
}
