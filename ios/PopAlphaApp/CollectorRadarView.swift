import SwiftUI

// MARK: - Collector Radar View
// Hexagonal radar chart showing 6 collector style axes.
// Mirrors the web CollectorRadar SVG component.

struct CollectorRadarView: View {
    let profile: APIRadarProfile

    private let axes: [(label: String, value: KeyPath<APIRadarProfile, Double>)] = [
        ("Vintage",  \.vintage),
        ("Graded",   \.graded),
        ("Grail",    \.grailHunter),
        ("Japanese", \.japanese),
        ("Sets",     \.setFinisher),
        ("Premium",  \.premium),
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

            // Data polygon — fill
            var fill = Path()
            for (i, axis) in axes.enumerated() {
                let pt = point(i, radius: r * profile[keyPath: axis.value])
                i == 0 ? fill.move(to: pt) : fill.addLine(to: pt)
            }
            fill.closeSubpath()
            ctx.fill(fill, with: .color(accentColor.opacity(0.25)))

            // Data polygon — stroke
            ctx.stroke(fill, with: .color(accentColor), style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))

            // Data-point dots
            for (i, axis) in axes.enumerated() {
                let pt = point(i, radius: r * profile[keyPath: axis.value])
                let dot = Path(ellipseIn: CGRect(x: pt.x - 3, y: pt.y - 3, width: 6, height: 6))
                ctx.fill(dot, with: .color(accentColor))
            }
        }
        .overlay(labelsOverlay)
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
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.55))
                    .position(x: x, y: y)
            }
        }
    }
}
