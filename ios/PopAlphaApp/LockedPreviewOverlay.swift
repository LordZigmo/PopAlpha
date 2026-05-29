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

            // Invisible-ink shimmer — a field of twinkling, drifting
            // particles over the blur so the locked preview reads as
            // "magically hidden" (à la iMessage invisible ink) rather
            // than merely blurred or broken.
            InvisibleInkShimmer()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)

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

/// iMessage "invisible ink"-style shimmer: a stable field of tiny
/// particles that twinkle and drift, drawn over blurred content so a
/// locked preview reads as "magically hidden" rather than merely blurred.
/// Canvas + TimelineView keeps it cheap — one redraw per frame, no
/// per-particle SwiftUI views. The field is deterministic (a seeded PRNG
/// re-seeded every frame), so only the time-driven twinkle + drift move;
/// the particle positions stay put, which reads as shimmer, not static.
struct InvisibleInkShimmer: View {
    var particleCount: Int = 220
    var tint: Color = .white

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                var rng = SplitMix64(seed: 0xA5A5_5A5A_C3C3_3C3C)
                for _ in 0..<particleCount {
                    let baseX = rng.nextUnit() * size.width
                    let baseY = rng.nextUnit() * size.height
                    let phase = rng.nextUnit() * 2 * .pi
                    let speed = 0.6 + rng.nextUnit() * 1.4
                    let twinkle = 0.5 + 0.5 * sin(t * 1.6 * speed + phase)
                    let radius = 0.4 + rng.nextUnit() * 1.3
                    let driftX = sin(t * speed + phase) * 1.1
                    let driftY = cos(t * speed * 0.8 + phase) * 1.1
                    let rect = CGRect(
                        x: baseX + driftX - radius,
                        y: baseY + driftY - radius,
                        width: radius * 2,
                        height: radius * 2
                    )
                    context.opacity = 0.12 + twinkle * 0.78
                    context.fill(Path(ellipseIn: rect), with: .color(tint))
                }
            }
        }
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }
}

/// Tiny deterministic PRNG (SplitMix64) so the shimmer's particle field is
/// identical every frame — only the time-driven twinkle/drift animates.
private struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Next value in [0, 1).
    mutating func nextUnit() -> Double {
        Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0)
    }
}
