import SwiftUI

// MARK: - Portfolio Value Chart
// A premium chart for the portfolio hero — gradient fill, smooth curves,
// glow on the leading edge, and a subtle baseline.

struct PortfolioValueChart: View {
    let data: [Double]
    let isPositive: Bool
    var height: CGFloat = 110

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
                    // Gradient fill below the line
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

                    // Leading edge dot with glow
                    if let last = points.last {
                        ZStack {
                            Circle()
                                .fill(lineColor.opacity(0.25))
                                .frame(width: 18, height: 18)
                            Circle()
                                .fill(lineColor)
                                .frame(width: 7, height: 7)
                                .shadow(color: lineColor, radius: 4)
                        }
                        .position(last)
                    }
                }
            }
        }
        .frame(height: height)
    }

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

#Preview("Positive") {
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

#Preview("Negative") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioValueChart(
            data: [70, 68, 65, 62, 60, 58, 55, 53, 50, 48, 47, 45, 44, 42],
            isPositive: false
        )
        .padding()
    }
    .preferredColorScheme(.dark)
}
