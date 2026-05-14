import SwiftUI

// MARK: - Collector Radar Card
// Standalone card that wraps the radar chart with the same premium
// surface treatment as the collector identity card. Lives independently
// on the portfolio page so the radar can be repositioned without
// affecting the type/traits content.
//
// When `identity` is provided, the header shows the collector type
// instead of the generic radar header, and a tap-to-expand "Why X?"
// disclosure is appended below the canvas. This combined mode lets
// the type + radar render as a single screenshot-friendly surface.

struct CollectorRadarCard: View {
    let profile: APIRadarProfile
    var identity: CollectorIdentityProfile? = nil
    var badges: [APIBadge] = []

    @State private var explanationExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            CollectorRadarView(profile: profile)
                .frame(height: 240)
            if !badges.isEmpty {
                badgeRow
            }
            if let identity {
                explanationDisclosure(identity)
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

    @ViewBuilder
    private var header: some View {
        if let identity {
            identityHeader(identity)
        } else {
            radarHeader
        }
    }

    private func identityHeader(_ identity: CollectorIdentityProfile) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.32))
                    .frame(width: 44, height: 44)
                Image(systemName: identity.primaryType.icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("YOUR COLLECTOR TYPE")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                    .tracking(0.8)

                Text(identity.primaryType.rawValue)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
            }

            Spacer()

            confidenceMeter(identity.confidence)
        }
    }

    private var radarHeader: some View {
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

    private func confidenceMeter(_ confidence: Double) -> some View {
        VStack(spacing: 3) {
            Text("\(Int(confidence * 100))%")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.accent)

            HStack(spacing: 2) {
                ForEach(0..<5, id: \.self) { i in
                    let threshold = Double(i + 1) / 5.0
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(confidence >= threshold ? PA.Colors.accent : PA.Colors.surfaceSoft)
                        .frame(width: 6, height: 3)
                }
            }
        }
    }

    // MARK: - Explanation Disclosure
    // Collapsed by default so the combined card stays compact for
    // screenshots. Tap reveals the explanation text + trait pills.

    private func explanationDisclosure(_ identity: CollectorIdentityProfile) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().background(PA.Colors.border)

            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    explanationExpanded.toggle()
                }
                PAHaptics.selection()
            } label: {
                HStack(spacing: 6) {
                    Text(explanationExpanded ? "Hide details" : "Why \"\(identity.primaryType.rawValue)\"?")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)

                    Spacer()

                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .rotationEffect(.degrees(explanationExpanded ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if explanationExpanded {
                Text(identity.explanation)
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.text)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)

                if !identity.traits.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(identity.traits) { trait in
                            traitPill(trait)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func traitPill(_ trait: CollectorTrait) -> some View {
        let tint = collectorTypeTint(trait.type)
        return HStack(spacing: 5) {
            Image(systemName: trait.type.icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(tint)
            Text(trait.type.rawValue)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.16))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(tint.opacity(0.45), lineWidth: 0.75)
        )
    }

    /// Map each archetype to the radar axis it leans on. Used for both
    /// trait pills here and could be reused if archetypes ever surface
    /// elsewhere as colored chips.
    private func collectorTypeTint(_ type: CollectorType) -> Color {
        switch type {
        case .grailHunter:        return PA.AxisColors.marketHeat
        case .setFinisher:        return PA.AxisColors.collectionDepth
        case .nostalgiaCurator:   return PA.AxisColors.nostalgia
        case .modernMomentum:     return PA.AxisColors.currentEra
        case .trophyCollector:    return PA.Colors.gold
        case .marketOpportunist:  return PA.Colors.accent
        case .completionist:      return PA.AxisColors.collectionDepth
        case .gradedPurist:       return PA.AxisColors.slabFocus
        case .binderBuilder:      return PA.AxisColors.collectionDepth
        case .sealedStrategist:   return PA.AxisColors.tasteProfile
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
