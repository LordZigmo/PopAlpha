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
            //
            // Feathered mask (not a hard clipShape) so the dust dissolves
            // softly into the card instead of ending at a crisp rectangular
            // border — the hard edge read as unprofessional.
            InvisibleInkShimmer()
                .mask(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white)
                        .padding(2)
                        .blur(radius: 7)
                )
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

/// iMessage "invisible ink"-style shimmer: a dense field of fine,
/// scintillating particles drawn over blurred content so a locked preview
/// reads as "magically hidden" rather than merely blurred. Canvas +
/// TimelineView keeps it cheap — one redraw per frame, no per-particle
/// SwiftUI views. The field is deterministic (a seeded PRNG re-seeded every
/// frame), so particle positions stay put while the time-driven
/// scintillation + micro-drift animate.
///
/// Quality notes (what makes it read as "ink dust" and not "noise"):
///   • Density — a dense, fine grain of ~1000 sub-pixel particles, not
///     scattered dots; fineness (sub-pixel radius + blur) keeps it elegant
///     even at high count.
///   • Scintillation — brightness is sin raised to a power, so each particle
///     sits dim and briefly flares; at any instant a different subset is lit,
///     which reads as sparkle rather than a uniform pulse.
///   • Depth — ~14% are larger, slower "glints" layered over the fine dust.
///   • Motion — a small two-frequency drift jiggles each particle organically.
///   • A faint blur + additive (.plusLighter) blending fuses the grain into
///     glowing dust instead of crisp pixels.
struct InvisibleInkShimmer: View {
    var particleCount: Int = 1000
    var tint: Color = .white

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                var rng = SplitMix64(seed: 0xC0FF_EE15_600D_5EED)
                // Additive blending so overlapping particles brighten into
                // soft clusters rather than flat-stacking.
                context.blendMode = .plusLighter
                for _ in 0..<particleCount {
                    let baseX = rng.nextUnit() * size.width
                    let baseY = rng.nextUnit() * size.height
                    let phase = rng.nextUnit() * 2 * .pi
                    let isGlint = rng.nextUnit() > 0.86

                    // Scintillation: pow() makes each particle flare briefly
                    // then sit dim, so the field sparkles instead of pulsing.
                    let speed = isGlint ? (0.9 + rng.nextUnit() * 1.2)
                                        : (2.0 + rng.nextUnit() * 3.5)
                    let s = 0.5 + 0.5 * sin(t * speed + phase)
                    // s^2 for glints, s^3 for dust: dust still flares-then-dims
                    // (reads as sparkle), but more of the field is lit at any
                    // instant than the old s^4, so it feels alive, not sparse.
                    let twinkle = isGlint ? s * s : s * s * s

                    // Organic micro-drift from two layered frequencies.
                    let driftMag = isGlint ? 1.3 : 0.7
                    let driftX = (sin(t * 0.7 * speed + phase) * 0.7
                        + sin(t * 1.9 * speed + phase * 1.7) * 0.3) * driftMag
                    let driftY = (cos(t * 0.6 * speed + phase) * 0.7
                        + cos(t * 2.2 * speed + phase * 1.3) * 0.3) * driftMag

                    let radius = isGlint ? (0.9 + rng.nextUnit() * 1.0)
                                         : (0.25 + rng.nextUnit() * 0.5)
                    let rect = CGRect(
                        x: baseX + driftX - radius,
                        y: baseY + driftY - radius,
                        width: radius * 2,
                        height: radius * 2
                    )
                    // Present silver dust (à la iMessage), not faint: a small
                    // always-on floor so the grain reads even at rest, plus a
                    // brighter flare. Fine radius + blur keep it soft, not gaudy.
                    context.opacity = (isGlint ? 0.09 : 0.045) + twinkle * (isGlint ? 0.62 : 0.48)
                    context.fill(Path(ellipseIn: rect), with: .color(tint))
                }
            }
        }
        .blur(radius: 0.5)
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
