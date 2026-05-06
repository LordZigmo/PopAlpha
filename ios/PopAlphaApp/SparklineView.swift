import SwiftUI

struct SparklineView: View {
    let data: [Double]
    let direction: ChangeDirection
    var lineWidth: CGFloat = 1.5
    var height: CGFloat = 32

    /// VoiceOver summary of the price trend. Without this, the chart is
    /// invisible to screen-reader users. Renders as e.g.
    /// "Price trend: $10.50 to $12.30, up 17 percent."
    private var accessibilitySummary: String {
        guard let first = data.first, let last = data.last,
              data.count >= 2 else {
            return "no data"
        }
        let pctChange: Double = first != 0
            ? ((last - first) / abs(first)) * 100
            : 0
        return String(
            format: "$%.2f to $%.2f, %@ %.0f percent",
            first, last, direction.accessibilityWord, abs(pctChange)
        )
    }

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
                                direction.color.opacity(0.15),
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
                        direction.color,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
                    )
                }
            )
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Price trend")
        .accessibilityValue(accessibilitySummary)
    }
}

// MARK: - Previews

#Preview("Sparkline Positive") {
    SparklineView(
        data: [105, 108, 112, 118, 115, 122, 130],
        direction: .up,
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
        direction: .down,
        lineWidth: 2,
        height: 60
    )
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}

#Preview("Sparkline Flat") {
    SparklineView(
        data: [200, 201, 199, 200, 200, 201, 200],
        direction: .flat,
        lineWidth: 2,
        height: 60
    )
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}
