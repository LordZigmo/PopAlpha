import SwiftUI

// MARK: - Portfolio Value Chart
// Premium scrubbable chart for the portfolio hero.
// - Smooth quadratic-curve line with gradient fill
// - Glowing leading-edge dot (when not scrubbing)
// - Vertical dashed cursor + glow dot at scrub position
// - Reports the scrub index to the parent so the hero can update its
//   value/change display in sync (stock-app feel).

struct PortfolioValueChart: View {
    let data: [Double]
    let isPositive: Bool
    var height: CGFloat = 110

    /// Called as the user scrubs. nil when the gesture ends.
    var onScrub: ((Int?) -> Void)? = nil

    @State private var scrubIndex: Int? = nil
    @State private var scrubbing: Bool = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let inset: CGFloat = 6

            if data.count >= 2,
               let minVal = data.min(),
               let maxVal = data.max() {

                let range = max(maxVal - minVal, 0.01)
                let stepX = (w - inset * 2) / CGFloat(data.count - 1)
                let points: [CGPoint] = data.enumerated().map { i, v in
                    let x = inset + CGFloat(i) * stepX
                    let normalized = CGFloat((v - minVal) / range)
                    let y = h - inset - normalized * (h - inset * 2)
                    return CGPoint(x: x, y: y)
                }

                ZStack {
                    // Fill below the line
                    smoothPath(points: points, closed: true, height: h)
                        .fill(
                            LinearGradient(
                                colors: [
                                    lineColor.opacity(0.35),
                                    lineColor.opacity(0.08),
                                    .clear,
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )

                    // Smooth line
                    smoothPath(points: points, closed: false, height: h)
                        .stroke(
                            lineGradient,
                            style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)
                        )
                        .shadow(color: lineColor.opacity(0.45), radius: 6, x: 0, y: 2)

                    // Default leading-edge dot (only when not scrubbing)
                    if !scrubbing, let last = points.last {
                        leadingDot
                            .position(last)
                    }

                    // Scrubber overlay
                    if scrubbing, let idx = scrubIndex, idx < points.count {
                        scrubberOverlay(at: points[idx], in: geo.size)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let x = max(0, min(w, value.location.x))
                            let idx = max(0, min(data.count - 1, Int(round((x - inset) / stepX))))
                            withAnimation(.interactiveSpring(response: 0.12)) {
                                scrubbing = true
                                scrubIndex = idx
                            }
                            onScrub?(idx)
                        }
                        .onEnded { _ in
                            withAnimation(.easeOut(duration: 0.2)) {
                                scrubbing = false
                                scrubIndex = nil
                            }
                            onScrub?(nil)
                        }
                )
            }
        }
        .frame(height: height)
    }

    // MARK: - Sub-views

    private var leadingDot: some View {
        ZStack {
            Circle()
                .fill(lineColor.opacity(0.25))
                .frame(width: 18, height: 18)
            Circle()
                .fill(lineColor)
                .frame(width: 7, height: 7)
                .shadow(color: lineColor, radius: 4)
        }
    }

    private func scrubberOverlay(at point: CGPoint, in size: CGSize) -> some View {
        ZStack {
            // Vertical dashed cursor line spans full height
            Path { p in
                p.move(to: CGPoint(x: point.x, y: 0))
                p.addLine(to: CGPoint(x: point.x, y: size.height))
            }
            .stroke(
                Color.white.opacity(0.25),
                style: StrokeStyle(lineWidth: 1, dash: [4, 3])
            )

            // Glow ring + dot at the scrub point
            Circle()
                .fill(lineColor.opacity(0.25))
                .frame(width: 22, height: 22)
                .position(point)
            Circle()
                .fill(lineColor)
                .frame(width: 9, height: 9)
                .shadow(color: lineColor, radius: 5)
                .position(point)
            Circle()
                .stroke(Color.white.opacity(0.35), lineWidth: 1.5)
                .frame(width: 16, height: 16)
                .position(point)
        }
    }

    // MARK: - Style helpers

    private var lineColor: Color {
        isPositive ? PA.Colors.positive : PA.Colors.negative
    }

    private var lineGradient: LinearGradient {
        LinearGradient(
            colors: [lineColor.opacity(0.7), lineColor],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    /// Catmull-Rom-style smoothed path. Falls back to straight segments
    /// for very short datasets.
    private func smoothPath(points: [CGPoint], closed: Bool, height: CGFloat) -> Path {
        Path { path in
            guard let first = points.first else { return }

            if closed {
                path.move(to: CGPoint(x: first.x, y: height))
                path.addLine(to: first)
            } else {
                path.move(to: first)
            }

            if points.count == 2 {
                path.addLine(to: points[1])
            } else {
                for i in 1..<points.count {
                    let prev = points[i - 1]
                    let curr = points[i]
                    let mid = CGPoint(x: (prev.x + curr.x) / 2, y: (prev.y + curr.y) / 2)
                    path.addQuadCurve(to: mid, control: prev)
                    if i == points.count - 1 {
                        path.addQuadCurve(to: curr, control: curr)
                    }
                }
            }

            if closed, let last = points.last {
                path.addLine(to: CGPoint(x: last.x, y: height))
                path.closeSubpath()
            }
        }
    }
}

#Preview("Scrubbable") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioValueChart(
            data: [50, 52, 51, 54, 55, 53, 57, 60, 58, 62, 64, 63, 67, 70],
            isPositive: true
        )
        .padding()
    }
    .preferredColorScheme(.dark)
}
