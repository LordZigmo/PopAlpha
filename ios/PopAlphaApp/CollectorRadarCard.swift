import SwiftUI

// MARK: - Collector Radar Card
// Standalone card that wraps the radar chart with the same premium
// surface treatment as the collector identity card. Lives independently
// on the portfolio page so the radar can be repositioned without
// affecting the type/traits content. The collector type itself renders
// in its own CollectorIdentityCard pinned to the top of the portfolio.

struct CollectorRadarCard: View {
    let profile: APIRadarProfile
    var badges: [APIBadge] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            CollectorRadarView(profile: profile)
                .frame(height: 240)
            if !badges.isEmpty {
                badgeRow
            }
        }
        .padding(20)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(accentBorder)
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Badge Row
    // Earned-only modifiers surfaced under the radar. Server returns
    // only badges the user qualifies for, so an empty list hides the row.

    private var badgeRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(badges) { badge in
                    badgeChip(badge)
                }
            }
        }
        .scrollClipDisabled()
    }

    private func badgeChip(_ badge: APIBadge) -> some View {
        let tint = badgeTint(badge.id)
        return HStack(spacing: 6) {
            Image(systemName: badge.icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(tint)
            Text(badge.label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.14))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(tint.opacity(0.45), lineWidth: 0.75)
        )
    }

    /// Maps each earned badge to the radar axis it expresses. Badge color
    /// = axis color, so a Grail Hunter chip is the same red-orange as
    /// Market Heat and a Vintage Loyalist is the same amber as Nostalgia.
    /// Japanese Specialist is its own (it's an axis-less modifier).
    private func badgeTint(_ id: String) -> Color {
        switch id {
        case "japanese_specialist":      return PA.AxisColors.japanese
        case "grail_hunter":             return PA.AxisColors.marketHeat
        case "binder_builder":           return PA.AxisColors.collectionDepth
        case "slab_collector":           return PA.AxisColors.slabFocus
        case "modern_chase_collector":   return PA.AxisColors.currentEra
        case "vintage_loyalist":         return PA.AxisColors.nostalgia
        case "art_first_collector":      return PA.AxisColors.tasteProfile
        case "set_completionist":        return PA.AxisColors.collectionDepth
        default:                         return PA.Colors.accent
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.32))
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
                colors: [PA.Colors.accent.opacity(0.32), .clear],
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
                        PA.Colors.accent.opacity(0.62),
                        PA.Colors.accent.opacity(0.30),
                        Color.white.opacity(0.05),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                lineWidth: 1
            )
    }
}
