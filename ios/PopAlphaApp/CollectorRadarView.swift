import SwiftUI

// MARK: - Collector Radar View
// Hexagonal radar chart showing 6 collector style axes.
// Mirrors the web CollectorRadar SVG component.

struct CollectorRadarView: View {
    let profile: APIRadarProfile

    /// Drives the data polygon expanding from center on first appearance.
    /// Grid + spokes are unaffected so the frame is always present.
    @State private var dataProgress: Double = 0

    // Order matters — opposite vertices read as conceptual contrasts:
    //   Nostalgia ↔ Current (old vs new era)
    //   Slab ↔ Taste (technical/condition vs aesthetic)
    //   Heat ↔ Depth (chase vs binder-builder)
    //
    // Each axis carries the same color as the badge that maps to it,
    // so a green Binder Builder pill visually keys into the green Depth
    // vertex on the chart.
    private let axes: [(label: String, value: KeyPath<APIRadarProfile, Double>, tint: Color)] = [
        ("Nostalgia", \.nostalgia,       PA.AxisColors.nostalgia),
        ("Slab",      \.slabFocus,       PA.AxisColors.slabFocus),
        ("Heat",      \.marketHeat,      PA.AxisColors.marketHeat),
        ("Current",   \.currentEra,      PA.AxisColors.currentEra),
        ("Taste",     \.tasteProfile,    PA.AxisColors.tasteProfile),
        ("Depth",     \.collectionDepth, PA.AxisColors.collectionDepth),
    ]

    private let accentColor = PA.Colors.accent // #00B4D8
    private let gridColor   = Color.white.opacity(0.08)
    private let rings       = 4

    var body: some View {
        Canvas { ctx, size in
            let cx = size.width  / 2
            let cy = size.height / 2
            let r  = min(cx, cy) * 0.72
            let n  = axes.count

            func point(_ index: Int, radius: Double) -> CGPoint {
                let angle = (Double(index) / Double(n)) * 2 * .pi - .pi / 2
                return CGPoint(x: cx + radius * cos(angle), y: cy + radius * sin(angle))
            }

            // Grid rings
            for ring in 1...rings {
                let frac = Double(ring) / Double(rings)
                var path = Path()
                path.move(to: point(0, radius: r * frac))
                for i in 1..<n { path.addLine(to: point(i, radius: r * frac)) }
                path.closeSubpath()
                ctx.stroke(path, with: .color(gridColor), lineWidth: 1)
            }

            // Axis spokes
            for i in 0..<n {
                var path = Path()
                path.move(to: CGPoint(x: cx, y: cy))
                path.addLine(to: point(i, radius: r))
                ctx.stroke(path, with: .color(gridColor), lineWidth: 1)
            }

            // Sparse profiles (e.g., user has 4 cards) produce tiny
            // raw axis values that read as a near-invisible polygon.
            // A sqrt curve lifts low values disproportionately so the
            // shape feels populated without distorting relative
            // emphasis (ordering is preserved).
            //   0.10 -> 0.32, 0.25 -> 0.50, 0.50 -> 0.71, 1.0 -> 1.0
            func display(_ raw: Double) -> Double {
                let v = max(0, raw)
                guard v > 0 else { return 0 }   // a truly empty axis sits at the center
                // Floor so a small-but-nonzero category plots clearly OFF
                // the center anchor — the user has a little of a type, so
                // show it rather than burying it as a smudge at the origin —
                // while it stays the smallest point on the chart. Only lifts
                // values whose sqrt is below the floor (~raw < 0.026); larger
                // values keep the sqrt emphasis curve unchanged.
                let minRadius = 0.16
                return max(minRadius, sqrt(v)) * dataProgress
            }

            // Data polygon — fill
            var fill = Path()
            for (i, axis) in axes.enumerated() {
                let pt = point(i, radius: r * display(profile[keyPath: axis.value]))
                i == 0 ? fill.move(to: pt) : fill.addLine(to: pt)
            }
            fill.closeSubpath()
            ctx.fill(fill, with: .color(accentColor.opacity(0.50)))

            // Data polygon — stroke
            ctx.stroke(fill, with: .color(accentColor), style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))

            // Data-point dots — each tinted with its axis color so the
            // vertices key into their badges. Slightly larger (radius 4)
            // so the colors register at a glance.
            for (i, axis) in axes.enumerated() {
                let pt = point(i, radius: r * display(profile[keyPath: axis.value]))
                let dot = Path(ellipseIn: CGRect(x: pt.x - 4, y: pt.y - 4, width: 8, height: 8))
                ctx.fill(dot, with: .color(axis.tint))
            }

            // Center origin anchor — ALWAYS the default graph color, drawn
            // ON TOP of the vertex dots so a zero-value axis (whose vertex
            // collapses onto the center) can never make the middle of the
            // chart read as that axis's tint. With the display() floor any
            // nonzero axis is already lifted off-center, so this only ever
            // covers a genuinely-empty axis. The faint ring reads it as an
            // intentional anchor rather than a stray point.
            let centerR: Double = 3.5
            let centerDot = Path(ellipseIn: CGRect(x: cx - centerR, y: cy - centerR, width: centerR * 2, height: centerR * 2))
            ctx.fill(centerDot, with: .color(accentColor))
            ctx.stroke(centerDot, with: .color(.white.opacity(0.25)), lineWidth: 0.75)
        }
        .overlay(labelsOverlay)
        .task {
            // .task runs reliably even when the parent applies
            // .disabled / .allowsHitTesting modifiers that can
            // disrupt SwiftUI .onAppear timing for embedded Canvas
            // views (the radar was rendering with dataProgress
            // stuck at 0 inside PortfolioDemoView before this).
            // Slight delay so the user sees the polygon "draw in"
            // rather than catching the tail end while the page settles.
            try? await Task.sleep(for: .milliseconds(150))
            withAnimation(.easeOut(duration: 0.9)) {
                dataProgress = 1
            }
        }
    }

    // Labels rendered as SwiftUI Text so they scale with Dynamic Type.
    private var labelsOverlay: some View {
        GeometryReader { geo in
            let cx = geo.size.width  / 2
            let cy = geo.size.height / 2
            let r  = min(cx, cy) * 0.72
            let lr = r + 22          // label radius
            let n  = axes.count

            ForEach(Array(axes.enumerated()), id: \.offset) { i, axis in
                let angle = (Double(i) / Double(n)) * 2 * .pi - .pi / 2
                let x = cx + lr * cos(angle)
                let y = cy + lr * sin(angle)

                Text(axis.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(axis.tint)
                    .position(x: x, y: y)
            }
        }
    }
}
