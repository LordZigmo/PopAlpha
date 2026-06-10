// LockedPreviewOverlay.swift
//
// Shared "full-gloss frost" wrapper used by every Pro-gated surface that
// renders a preview behind a paywall.
//
// Design (revised 2026-06-10 — replaced the blur+particle-dust treatment,
// which read as a box floating over half-hidden content with visible mask
// edges):
//   • Commit fully to the gloss: the wrapped content is blurred far past
//     legibility into an abstract color aura, so each module keeps its
//     hue identity (the brief glows teal, the insight glows purple) while
//     nothing structural reads through.
//   • A real system material (.ultraThinMaterial) washes edge-to-edge
//     with a feathered mask — no inner box, no crisp border, and it
//     adapts to light/dark + Reduce Transparency for free.
//   • One slow specular sheen sweeps diagonally every ~7s — a whisper of
//     holo-foil, on-brand for a TCG app. Static under Reduce Motion.
//   • The lock state is a composed, centered column (material lock badge,
//     "POPALPHA PRO" eyebrow, accent CTA capsule) instead of a floating
//     pill — and the ENTIRE surface is the tap target, not just the pill.
//
// Used by:
//   - CardDetailView (AI market summary, free-tier branch)
//   - PersonalizedInsightCardView (collector-style insight, free-tier branch)
//   - CollectorRadarLockedCard (entire radar canvas)
//
// Layout contract (unchanged): the wrapped content renders live at its
// natural size, so toggling the lock state never reshuffles the parent.

import SwiftUI

struct LockedPreviewOverlay<Content: View>: View {
    let ctaText: String
    /// Retained for call-site compatibility; the frost enforces its own
    /// far-stronger floor so content can never be legible regardless of
    /// what a caller passes.
    let blurRadius: CGFloat
    let onTap: () -> Void
    @ViewBuilder let content: () -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        ctaText: String,
        blurRadius: CGFloat = 5,
        onTap: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.ctaText = ctaText
        self.blurRadius = blurRadius
        self.onTap = onTap
        self.content = content
    }

    var body: some View {
        Button(action: onTap) {
            ZStack {
                // The real content, dissolved into a color aura. Saturation
                // is nudged up so the aura glows with the module's brand
                // hue instead of going muddy under the frost.
                content()
                    .blur(radius: max(blurRadius * 3.5, 16))
                    .saturation(1.15)
                    .opacity(0.9)
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)

                // Edge-to-edge frost. Feathered mask (soft-blurred fill,
                // not a clipShape) so the material dissolves into whatever
                // container it sits in — no visible rectangle, no corner-
                // radius assumptions about the parent card.
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .mask(
                        Rectangle()
                            .fill(Color.white)
                            .padding(1)
                            .blur(radius: 5)
                    )
                    .allowsHitTesting(false)

                // Holo-foil sheen: one narrow specular band drifting
                // diagonally on a slow loop. Additive blend + low opacity
                // keep it at "did the light just catch that?" level.
                if !reduceMotion {
                    specularSheen
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }

                lockState
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ctaText)
        .accessibilityHint("Opens the PopAlpha Pro paywall")
    }

    // MARK: - Lock state

    private var lockState: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 44, height: 44)
                    .overlay(
                        Circle().strokeBorder(
                            LinearGradient(
                                colors: [Color.white.opacity(0.35), Color.white.opacity(0.05)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1
                        )
                    )
                Image(systemName: "lock.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }

            Text("POPALPHA PRO")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.2)
                .foregroundStyle(PA.Colors.textSecondary)

            HStack(spacing: 6) {
                Text(ctaText)
                    .font(.system(size: 13, weight: .bold))
                Image(systemName: "arrow.right")
                    .font(.system(size: 11, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .background(
                LinearGradient(
                    colors: [PA.Colors.accent, PA.Colors.accent.opacity(0.85)],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .clipShape(Capsule())
            .shadow(color: PA.Colors.accent.opacity(0.35), radius: 14, x: 0, y: 5)
        }
        .padding(.vertical, 8)
    }

    // MARK: - Specular sheen

    /// Narrow diagonal highlight band sweeping the surface every ~7s.
    /// Built from gradient stops (no GeometryReader needed): the band's
    /// center travels from past the leading edge to past the trailing
    /// edge; stop locations are clamped so the gradient stays valid at
    /// the extremes.
    private var specularSheen: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let period: Double = 7
            let phase = timeline.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: period) / period
            let center = -0.3 + phase * 1.6
            LinearGradient(
                stops: sheenStops(center: center),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
        .blendMode(.plusLighter)
        .opacity(0.16)
    }

    private func sheenStops(center: Double) -> [Gradient.Stop] {
        func clamp(_ value: Double) -> CGFloat {
            CGFloat(min(1, max(0, value)))
        }
        return [
            .init(color: .clear, location: 0),
            .init(color: .clear, location: clamp(center - 0.16)),
            .init(color: Color.white.opacity(0.55), location: clamp(center)),
            .init(color: .clear, location: clamp(center + 0.16)),
            .init(color: .clear, location: 1),
        ]
    }
}
