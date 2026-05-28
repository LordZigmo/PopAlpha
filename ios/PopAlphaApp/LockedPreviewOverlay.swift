// LockedPreviewOverlay.swift
//
// Shared "teaser + blur" wrapper used by every Pro-gated surface that
// renders a preview behind a paywall. Wraps content in a soft blur
// (so the user feels what they're missing without the actual data
// being legible) and overlays a centered cyan pill CTA.
//
// Used by:
//   - CardDetailView (AI market summary, free-tier branch)
//   - PersonalizedInsightCardView (collector-style insight, free-tier branch)
//   - CollectorRadarLockedCard (entire radar canvas)
//
// Design notes:
//   - The wrapped content is rendered live — same layout, same height —
//     so adding/removing the lock state doesn't reshuffle anything
//     above or below in the parent layout.
//   - .allowsHitTesting(false) on the blurred content means taps fall
//     through to the CTA pill underneath. The pill is the only
//     interactive element while locked.
//   - The bottom gradient fade sells "preview" rather than "broken" —
//     the blurred content visibly trails off into the surface color
//     rather than ending at a hard edge.

import SwiftUI

struct LockedPreviewOverlay<Content: View>: View {
    let ctaText: String
    let blurRadius: CGFloat
    let onTap: () -> Void
    @ViewBuilder let content: () -> Content

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
        ZStack {
            content()
                .blur(radius: blurRadius)
                .accessibilityHidden(true)
                .allowsHitTesting(false)

            // Soft fade at the bottom so blurred content reads as a
            // preview rather than a broken render.
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                LinearGradient(
                    colors: [Color.clear, PA.Colors.background.opacity(0.55)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 48)
            }
            .allowsHitTesting(false)

            Button(action: onTap) {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 11, weight: .semibold))
                    Text(ctaText)
                        .font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(
                    LinearGradient(
                        colors: [PA.Colors.accent, PA.Colors.accent.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .clipShape(Capsule())
                .shadow(color: PA.Colors.accent.opacity(0.45), radius: 12, x: 0, y: 4)
            }
            .buttonStyle(.plain)
        }
    }
}
