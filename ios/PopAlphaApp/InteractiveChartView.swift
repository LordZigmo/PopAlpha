import SwiftUI

// MARK: - Interactive Price Chart (stock-tracker style scrubber)

struct InteractiveChartView: View {
    let data: [Double]
    let timestamps: [String]
    let direction: ChangeDirection
    var lineWidth: CGFloat = 2
    var height: CGFloat = 120
    /// Draws dashed bound lines at the window's high and low with dollar
    /// labels — the technical "range" read. The plot is inset vertically
    /// to make room, so leave this off for compact sparkline uses.
    var showsBounds: Bool = false

    @State private var scrubbing = false
    @State private var scrubIndex: Int?

    private var displayPrice: String? {
        guard let idx = scrubIndex, idx < data.count else { return nil }
        let val = data[idx]
        if val >= 1000 {
            return String(format: "$%.0f", val)
        }
        return String(format: "$%.2f", val)
    }

    private var displayTimestamp: String? {
        guard let idx = scrubIndex, idx < timestamps.count else { return nil }
        return formatTimestamp(timestamps[idx])
    }

    private var displayChange: (text: String, direction: ChangeDirection)? {
        guard let idx = scrubIndex, idx < data.count, let first = data.first, first > 0 else { return nil }
        let current = data[idx]
        let pct = ((current - first) / first) * 100
        let sign = pct > 0 ? "+" : ""
        return ("\(sign)\(String(format: "%.2f", pct))%", ChangeDirection.from(pct))
    }

    /// 24h (previous-day) change for the scrubbed day. Daily snapshots make
    /// the previous point ≈ 24h; nil at the first point (no prior day).
    private var display24h: (text: String, direction: ChangeDirection)? {
        guard let idx = scrubIndex, idx > 0, idx < data.count else { return nil }
        let prev = data[idx - 1]
        guard prev > 0 else { return nil }
        let pct = ((data[idx] - prev) / prev) * 100
        let sign = pct > 0 ? "+" : ""
        return ("\(sign)\(String(format: "%.2f", pct))%", ChangeDirection.from(pct))
    }

    /// VoiceOver summary so the scrubber-based chart is at least
    /// describable to screen readers (the drag gesture itself is not
    /// reachable via VoiceOver). Reads e.g. "Price chart, $10.50 to
    /// $12.30, up 17 percent over 10 data points."
    private var accessibilitySummary: String {
        guard let first = data.first, let last = data.last,
              data.count >= 2 else {
            return "no data"
        }
        let pctChange: Double = first != 0
            ? ((last - first) / abs(first)) * 100
            : 0
        return String(
            format: "$%.2f to $%.2f, %@ %.0f percent over %d data points",
            first, last, direction.accessibilityWord, abs(pctChange), data.count
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Scrub price overlay
            priceOverlay

            // Chart with gesture
            GeometryReader { geo in
                let w = geo.size.width
                let h = geo.size.height

                if data.count >= 2,
                   let minVal = data.min(),
                   let maxVal = data.max() {

                    // When every point is identical (common for graded
                    // cards with stable Scrydex `market` estimates) the
                    // strict maxVal > minVal gate used to skip the entire
                    // chart body, leaving the user with a "Calibrated on N
                    // data points" caption but no visible line. Treat
                    // a zero-range series as a flat midline instead so
                    // the user sees the data exists and isn't moving.
                    let range = maxVal - minVal
                    let step = w / CGFloat(data.count - 1)
                    let flat = range <= 0
                    // Bounds mode insets the plot so the high/low labels fit
                    // above and below the dashed lines without clipping.
                    let inset: CGFloat = (showsBounds && !flat) ? 16 : 0
                    let plotH = h - inset * 2
                    let points: [CGPoint] = data.enumerated().map { i, val in
                        CGPoint(
                            x: CGFloat(i) * step,
                            y: flat
                                ? h * 0.5
                                : inset + plotH - ((CGFloat(val - minVal) / CGFloat(range)) * plotH)
                        )
                    }

                    ZStack {
                        if showsBounds, !flat {
                            boundsOverlay(minVal: minVal, maxVal: maxVal, topY: inset, bottomY: h - inset, width: w)
                        }
                        // Fill gradient
                        fillPath(points: points, height: h)
                        // Line
                        linePath(points: points)

                        // Scrubber
                        if scrubbing, let idx = scrubIndex, idx < points.count {
                            scrubberOverlay(at: points[idx], in: geo.size)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                let x = value.location.x
                                let idx = max(0, min(data.count - 1, Int((x / w) * CGFloat(data.count))))
                                withAnimation(.interactiveSpring(response: 0.15)) {
                                    scrubbing = true
                                    scrubIndex = idx
                                }
                            }
                            .onEnded { _ in
                                withAnimation(.easeOut(duration: 0.25)) {
                                    scrubbing = false
                                    scrubIndex = nil
                                }
                            }
                    )
                } else {
                    // Not enough data
                    Rectangle()
                        .fill(.clear)
                }
            }
            .frame(height: height)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Price chart")
        .accessibilityValue(accessibilitySummary)
    }

    // MARK: - Price Overlay (shown while scrubbing)

    @ViewBuilder
    private var priceOverlay: some View {
        if scrubbing, let price = displayPrice {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(price)
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)

                if let change = displayChange {
                    (Text("start ")
                        .font(.system(size: 11))
                        .foregroundColor(PA.Colors.muted)
                     + Text(change.text)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(change.direction.color))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }

                if let d24 = display24h {
                    (Text("24h ")
                        .font(.system(size: 11))
                        .foregroundColor(PA.Colors.muted)
                     + Text(d24.text)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(d24.direction.color))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }

                Spacer()

                if let ts = displayTimestamp {
                    Text(ts)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
            .padding(.horizontal, 2)
            .transition(.opacity)
        } else {
            Color.clear.frame(height: 28)
        }
    }

    // MARK: - Scrubber Line + Dot

    private func scrubberOverlay(at point: CGPoint, in size: CGSize) -> some View {
        ZStack {
            // Vertical dashed line
            Path { path in
                path.move(to: CGPoint(x: point.x, y: 0))
                path.addLine(to: CGPoint(x: point.x, y: size.height))
            }
            .stroke(
                PA.Colors.hairline(0.2),
                style: StrokeStyle(lineWidth: 1, dash: [4, 3])
            )

            // Glow dot
            Circle()
                .fill(direction.color)
                .frame(width: 10, height: 10)
                .shadow(color: direction.color.opacity(0.5), radius: 6)
                .position(point)

            // Outer ring
            Circle()
                .stroke(PA.Colors.hairline(0.3), lineWidth: 1.5)
                .frame(width: 16, height: 16)
                .position(point)
        }
    }

    // MARK: - High/Low Bounds

    /// Dashed hairlines at the window's high and low with dollar labels
    /// (high above its line, low below) — anchored top-leading so the
    /// labels track the inset positions without measuring text.
    private func boundsOverlay(minVal: Double, maxVal: Double, topY: CGFloat, bottomY: CGFloat, width: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: topY))
                path.addLine(to: CGPoint(x: width, y: topY))
            }
            .stroke(PA.Colors.hairline(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))

            Path { path in
                path.move(to: CGPoint(x: 0, y: bottomY))
                path.addLine(to: CGPoint(x: width, y: bottomY))
            }
            .stroke(PA.Colors.hairline(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))

            Text(Self.formatBound(maxVal))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .offset(x: 2, y: topY - 14)

            Text(Self.formatBound(minVal))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .offset(x: 2, y: bottomY + 3)
        }
        .allowsHitTesting(false)
    }

    private static func formatBound(_ val: Double) -> String {
        val >= 1000 ? String(format: "$%.0f", val) : String(format: "$%.2f", val)
    }

    // MARK: - Chart Paths

    private func fillPath(points: [CGPoint], height: CGFloat) -> some View {
        Path { path in
            path.move(to: CGPoint(x: points[0].x, y: height))
            path.addLine(to: points[0])
            for pt in points.dropFirst() {
                path.addLine(to: pt)
            }
            path.addLine(to: CGPoint(x: points.last!.x, y: height))
            path.closeSubpath()
        }
        .fill(
            LinearGradient(
                colors: [
                    (scrubbing
                        ? PA.Colors.hairline(0.08)
                        : direction.color.opacity(0.15)),
                    .clear
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private func linePath(points: [CGPoint]) -> some View {
        Path { path in
            path.move(to: points[0])
            for pt in points.dropFirst() {
                path.addLine(to: pt)
            }
        }
        .stroke(
            direction.color,
            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
        )
    }

    // MARK: - Timestamp Formatting

    private func formatTimestamp(_ ts: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let date: Date
        if let d = isoFormatter.date(from: ts) {
            date = d
        } else {
            // Try without fractional seconds
            isoFormatter.formatOptions = [.withInternetDateTime]
            guard let d = isoFormatter.date(from: ts) else { return ts.prefix(10).description }
            date = d
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, h:mm a"
        return formatter.string(from: date)
    }
}

// MARK: - Previews

#Preview("Interactive Chart") {
    InteractiveChartView(
        data: [105, 108, 104, 112, 118, 115, 122, 119, 125, 130],
        timestamps: (0..<10).map { i in
            ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(i) * -86400))
        }.reversed(),
        direction: .up,
        height: 140
    )
    .padding()
    .background(PA.Colors.background)
}

#Preview("Interactive Chart Flat") {
    InteractiveChartView(
        data: [200, 201, 199, 200, 200, 201, 199, 200, 200, 200],
        timestamps: (0..<10).map { i in
            ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(i) * -86400))
        }.reversed(),
        direction: .flat,
        height: 140
    )
    .padding()
    .background(PA.Colors.background)
}
