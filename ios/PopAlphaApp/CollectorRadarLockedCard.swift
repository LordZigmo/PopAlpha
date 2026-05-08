// CollectorRadarLockedCard.swift
//
// Free-tier teaser version of CollectorRadarCard. Mounted by PortfolioView
// when:
//   - hasFullAnalysis is true (user has 3+ holdings, so the radar would
//     normally render with their actual style data), AND
//   - PremiumGate.isPro is false.
//
// Renders the same surface treatment as the real card — header, hex
// canvas, accent border — so the layout doesn't shift when the user
// upgrades. The radar canvas uses dummy axis values so the user sees
// the SHAPE of the feature without seeing their actual style breakdown.
// The whole canvas sits inside LockedPreviewOverlay; tap → presents
// PaywallView with the .collectorProfile context (hero copy: "Unlock
// your collector profile").

import SwiftUI

struct CollectorRadarLockedCard: View {
    @State private var showPaywall = false

    // Dummy axis values lifted from PortfolioDemoView's mock so the
    // hexagon has a recognizable, non-trivial shape. Free users see
    // the FEATURE rendering (radar with 6 axes labeled) without seeing
    // their actual style — that part is what they're paying for.
    private static let teaserProfile = APIRadarProfile(
        nostalgia: 0.42,
        currentEra: 0.55,
        slabFocus: 0.62,
        marketHeat: 0.48,
        tasteProfile: 0.38,
        collectionDepth: 0.72
    )

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            LockedPreviewOverlay(
                ctaText: "Unlock your collector profile",
                blurRadius: 6,
                onTap: { showPaywall = true },
            ) {
                CollectorRadarView(profile: Self.teaserProfile)
                    .frame(height: 240)
            }
        }
        .padding(20)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(accentBorder)
        .padding(.horizontal, PA.Layout.sectionPadding)
        .sheet(isPresented: $showPaywall) {
            PaywallView(context: .collectorProfile)
        }
    }

    // MARK: - Header
    //
    // Mirrors CollectorRadarCard.header but adds a tiny "PRO" pill so
    // the gate is obvious without reading the CTA.

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

            Text("PRO")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(PA.Colors.gold)
                .tracking(0.6)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(PA.Colors.gold.opacity(0.12))
                .clipShape(Capsule())
        }
    }

    // MARK: - Background + Border
    //
    // Visually identical to CollectorRadarCard so the upgrade swap is
    // seamless — only the canvas content changes.

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
