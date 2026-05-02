import SwiftUI

struct SparklineView: View {
    let data: [Double]
    let isPositive: Bool
    var lineWidth: CGFloat = 1.5
    var height: CGFloat = 32

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            guard data.count >= 2,
                  let minVal = data.min(),
                  let maxVal = data.max(),
                  maxVal > minVal else {
                return AnyView(EmptyView())
            }

            let range = maxVal - minVal
            let step = w / CGFloat(data.count - 1)

            let points: [CGPoint] = data.enumerated().map { i, val in
                CGPoint(
                    x: CGFloat(i) * step,
                    y: h - ((CGFloat(val - minVal) / CGFloat(range)) * h)
                )
            }

            return AnyView(
                ZStack {
                    // Fill gradient
                    Path { path in
                        guard let firstPoint = points.first, let lastPoint = points.last else { return }
                        path.move(to: CGPoint(x: firstPoint.x, y: h))
                        path.addLine(to: firstPoint)
                        for pt in points.dropFirst() {
                            path.addLine(to: pt)
                        }
                        path.addLine(to: CGPoint(x: lastPoint.x, y: h))
                        path.closeSubpath()
                    }
                    .fill(
                        LinearGradient(
                            colors: [
                                (isPositive ? PA.Colors.positive : PA.Colors.negative).opacity(0.15),
                                .clear
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    // Line
                    Path { path in
                        guard let firstPoint = points.first else { return }
                        path.move(to: firstPoint)
                        for pt in points.dropFirst() {
                            path.addLine(to: pt)
                        }
                    }
                    .stroke(
                        isPositive ? PA.Colors.positive : PA.Colors.negative,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
                    )
                }
            )
        }
        .frame(height: height)
    }
}

// MARK: - Previews

#Preview("Sparkline Positive") {
    SparklineView(
        data: [105, 108, 112, 118, 115, 122, 130],
        isPositive: true,
        lineWidth: 2,
        height: 60
    )
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}

#Preview("Sparkline Negative") {
    SparklineView(
        data: [430, 425, 420, 418, 415, 410, 412],
        isPositive: false,
        lineWidth: 2,
        height: 60
    )
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}
