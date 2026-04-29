import SwiftUI

// MARK: - Collector Radar Card
// Standalone card that wraps the radar chart with the same premium
// surface treatment as the collector identity card. Lives independently
// on the portfolio page so the radar can be repositioned without
// affecting the type/traits content.

struct CollectorRadarCard: View {
    let profile: APIRadarProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            CollectorRadarView(profile: profile)
                .frame(height: 240)
        }
        .padding(20)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(accentBorder)
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.12))
                    .frame(width: 32, height: 32)
                Image(systemName: "scope")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("COLLECTOR STYLE RADAR")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                    .tracking(0.8)

                Text("How your portfolio breaks down")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
            }

            Spacer()
        }
    }

    // MARK: - Background + Border

    private var cardBackground: some View {
        ZStack {
            PA.Gradients.cardSurface
            RadialGradient(
                colors: [PA.Colors.accent.opacity(0.06), .clear],
                center: .topTrailing,
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
