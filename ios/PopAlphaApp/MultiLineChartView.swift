import SwiftUI

// MARK: - Multi-Series Interactive Chart
//
// Overlays multiple price series on a SHARED TIME AXIS with a scrubber that
// reports, per series, the price plus the change-from-window-start and the
// 24h (previous-day) change for the touched day. Powers two surfaces:
//   • RAW edition overlay — Unlimited vs 1st Edition
//   • Grade Performance   — PSA grades (indexed by default)
//
// The single-series `InteractiveChartView` stays for the common one-line
// case; this view mirrors its visual language (PA tokens, dashed scrubber).
//
// IMPORTANT: unlike the single-series view (which positions points by array
// index), overlaid series rarely share identical timestamps or counts, so
// the x-axis here is mapped by TIME, not index — see `MultiSeriesChartModel`.

// MARK: - Pure layout / scrub model (UI-free, unit-testable)

struct MultiSeriesChartModel {
    struct Point: Equatable {
        let tsMs: Double
        let price: Double
    }

    struct Series: Identifiable {
        let id: String
        let label: String
        let color: Color
        /// Ascending by `tsMs`; non-positive prices already filtered out.
        let points: [Point]
    }

    enum Scale { case absolute, indexed }

    let series: [Series]
    let scale: Scale
    let minTs: Double
    let maxTs: Double
    let minVal: Double
    let maxVal: Double

    init(series: [Series], scale: Scale) {
        // A single point can't be drawn or scrubbed meaningfully.
        let cleaned = series.filter { $0.points.count >= 2 }
        self.series = cleaned
        self.scale = scale

        let allTs = cleaned.flatMap { $0.points.map(\.tsMs) }
        let allVals = cleaned.flatMap { Self.values(for: $0, scale: scale) }
        minTs = allTs.min() ?? 0
        maxTs = allTs.max() ?? 1
        minVal = allVals.min() ?? 0
        maxVal = allVals.max() ?? 1
    }

    var isEmpty: Bool { series.isEmpty }
    var tsRange: Double { Swift.max(maxTs - minTs, 1) }
    var valRange: Double { Swift.max(maxVal - minVal, 0.01) }

    /// Indexed mode rebases each series to 100 at its first in-window point,
    /// so momentum is comparable across very different price levels.
    static func transform(price: Double, base: Double, scale: Scale) -> Double {
        scale == .indexed && base > 0 ? price / base * 100 : price
    }

    static func values(for s: Series, scale: Scale) -> [Double] {
        let base = s.points.first?.price ?? 0
        return s.points.map { transform(price: $0.price, base: base, scale: scale) }
    }

    func x(tsMs: Double, width: CGFloat) -> CGFloat {
        CGFloat((tsMs - minTs) / tsRange) * width
    }

    func y(value: Double, height: CGFloat) -> CGFloat {
        height - CGFloat((value - minVal) / valRange) * height
    }

    /// Horizontal fraction [0,1] → timestamp on the shared axis.
    func tsAt(fraction: Double) -> Double {
        minTs + Swift.max(0, Swift.min(1, fraction)) * tsRange
    }

    /// Index of the point in `s` nearest a target timestamp.
    func nearestIndex(in s: Series, tsMs: Double) -> Int {
        guard !s.points.isEmpty else { return 0 }
        var best = 0
        var bestDelta = Double.infinity
        for (i, p) in s.points.enumerated() {
            let d = abs(p.tsMs - tsMs)
            if d < bestDelta { bestDelta = d; best = i }
        }
        return best
    }

    /// % change from the window's first point to index `i`.
    func changeFromStart(in s: Series, index i: Int) -> Double? {
        guard i >= 0, i < s.points.count, let base = s.points.first?.price, base > 0 else { return nil }
        return (s.points[i].price - base) / base * 100
    }

    /// 24h (previous-point) % change at index `i`.
    func change24h(in s: Series, index i: Int) -> Double? {
        guard i > 0, i < s.points.count else { return nil }
        let prev = s.points[i - 1].price
        guard prev > 0 else { return nil }
        return (s.points[i].price - prev) / prev * 100
    }
}

// MARK: - Timestamp parsing

enum ChartTimeParsing {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let dateOnly: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Milliseconds since epoch for an ISO8601 (with/without fractional
    /// seconds) or `yyyy-MM-dd` timestamp; nil if unparseable.
    static func ms(_ ts: String) -> Double? {
        if let d = iso.date(from: ts) { return d.timeIntervalSince1970 * 1000 }
        if let d = isoNoFraction.date(from: ts) { return d.timeIntervalSince1970 * 1000 }
        if let d = dateOnly.date(from: String(ts.prefix(10))) { return d.timeIntervalSince1970 * 1000 }
        return nil
    }
}

// MARK: - View input

struct MultiLineSeriesInput: Identifiable {
    let id: String
    let label: String
    let color: Color
    let points: [PricePoint]
}

// MARK: - View

struct MultiLineChartView: View {
    let series: [MultiLineSeriesInput]
    var scale: MultiSeriesChartModel.Scale = .absolute
    /// Adds per-series "from start" + "24h" deltas to the scrub readout.
    var showChangeDetails: Bool = false
    var height: CGFloat = 160
    /// Draws dashed bound lines at the window's high and low with value
    /// labels (dollars in absolute mode, % in indexed) — mirrors
    /// `InteractiveChartView.showsBounds` so the overlay chart and the
    /// single-line chart read identically. The plot insets vertically to
    /// make room; replaces the corner axis labels.
    var showsBounds: Bool = false

    /// Vertical room reserved for the bound lines + labels.
    private var plotInset: CGFloat { showsBounds ? 16 : 0 }

    @State private var scrubbing = false
    @State private var scrubFraction: Double = 0

    private var model: MultiSeriesChartModel {
        MultiSeriesChartModel(
            series: series.map { input in
                let pts = input.points
                    .compactMap { p -> MultiSeriesChartModel.Point? in
                        guard p.price > 0, let ms = ChartTimeParsing.ms(p.ts) else { return nil }
                        return MultiSeriesChartModel.Point(tsMs: ms, price: p.price)
                    }
                    .sorted { $0.tsMs < $1.tsMs }
                return MultiSeriesChartModel.Series(id: input.id, label: input.label, color: input.color, points: pts)
            },
            scale: scale
        )
    }

    var body: some View {
        let m = model
        VStack(alignment: .leading, spacing: 10) {
            chart(m)
                .frame(height: height)
                .overlay(alignment: .topLeading) {
                    // Bounds mode carries its own high/low labels on the
                    // dashed lines; the corner axis labels would double up.
                    if !showsBounds { axisLabels(m) }
                }
                .overlay(alignment: .top) {
                    if scrubbing, !m.isEmpty { readoutCard(m) }
                }
            legend(m)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Multi-series price chart")
        .accessibilityValue(accessibilitySummary(m))
    }

    // MARK: Chart body

    @ViewBuilder
    private func chart(_ m: MultiSeriesChartModel) -> some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            if m.isEmpty {
                emptyState
            } else {
                ZStack {
                    gridLines(h: h, w: w)
                    if showsBounds {
                        boundsOverlay(m, w: w, h: h)
                    }
                    if m.scale == .indexed, m.minVal <= 100, m.maxVal >= 100 {
                        baseline100(m, w: w, h: h)
                    }
                    ForEach(m.series) { s in
                        seriesFill(s, m: m, w: w, h: h)
                    }
                    ForEach(m.series) { s in
                        seriesLine(s, m: m, w: w, h: h)
                    }
                    if scrubbing {
                        scrubber(m, w: w, h: h)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let frac = Double(max(0, min(w, value.location.x)) / max(w, 1))
                            withAnimation(.interactiveSpring(response: 0.15)) {
                                scrubbing = true
                                scrubFraction = frac
                            }
                        }
                        .onEnded { _ in
                            withAnimation(.easeOut(duration: 0.25)) { scrubbing = false }
                        }
                )
            }
        }
    }

    /// Y position honoring the bounds inset — values map into the inset
    /// plot band so the dashed high/low lines sit exactly on the extremes.
    private func yPos(_ value: Double, m: MultiSeriesChartModel, h: CGFloat) -> CGFloat {
        plotInset + m.y(value: value, height: h - plotInset * 2)
    }

    private func seriesLine(_ s: MultiSeriesChartModel.Series, m: MultiSeriesChartModel, w: CGFloat, h: CGFloat) -> some View {
        let base = s.points.first?.price ?? 0
        return Path { path in
            for (i, p) in s.points.enumerated() {
                let pt = CGPoint(
                    x: m.x(tsMs: p.tsMs, width: w),
                    y: yPos(MultiSeriesChartModel.transform(price: p.price, base: base, scale: m.scale), m: m, h: h)
                )
                if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
            }
        }
        .stroke(s.color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
    }

    /// Soft gradient fill under each series — the same visual language as
    /// the single-line chart's fill, kept faint so overlapping series
    /// blend instead of muddying.
    private func seriesFill(_ s: MultiSeriesChartModel.Series, m: MultiSeriesChartModel, w: CGFloat, h: CGFloat) -> some View {
        let base = s.points.first?.price ?? 0
        let floorY = h - plotInset
        return Path { path in
            guard let first = s.points.first else { return }
            path.move(to: CGPoint(x: m.x(tsMs: first.tsMs, width: w), y: floorY))
            for p in s.points {
                path.addLine(to: CGPoint(
                    x: m.x(tsMs: p.tsMs, width: w),
                    y: yPos(MultiSeriesChartModel.transform(price: p.price, base: base, scale: m.scale), m: m, h: h)
                ))
            }
            path.addLine(to: CGPoint(x: m.x(tsMs: s.points.last!.tsMs, width: w), y: floorY))
            path.closeSubpath()
        }
        .fill(
            LinearGradient(
                colors: [s.color.opacity(0.10), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    /// Dashed hairlines at the window's high and low with value labels —
    /// dollars in absolute mode, signed % in indexed mode.
    private func boundsOverlay(_ m: MultiSeriesChartModel, w: CGFloat, h: CGFloat) -> some View {
        let topY = plotInset
        let bottomY = h - plotInset
        return ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: topY))
                path.addLine(to: CGPoint(x: w, y: topY))
            }
            .stroke(PA.Colors.hairline(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))

            Path { path in
                path.move(to: CGPoint(x: 0, y: bottomY))
                path.addLine(to: CGPoint(x: w, y: bottomY))
            }
            .stroke(PA.Colors.hairline(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))

            Text(m.scale == .indexed ? fmtSignedPct(m.maxVal - 100) : fmtUSD(m.maxVal))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .offset(x: 2, y: topY - 14)

            Text(m.scale == .indexed ? fmtSignedPct(m.minVal - 100) : fmtUSD(m.minVal))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .offset(x: 2, y: bottomY + 3)
        }
        .allowsHitTesting(false)
    }

    private func gridLines(h: CGFloat, w: CGFloat) -> some View {
        ForEach([0.0, 0.25, 0.5, 0.75, 1.0], id: \.self) { pct in
            Path { path in
                let y = h * pct
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: w, y: y))
            }
            .stroke(PA.Colors.hairline(0.05), lineWidth: 1)
        }
    }

    private func baseline100(_ m: MultiSeriesChartModel, w: CGFloat, h: CGFloat) -> some View {
        let y = yPos(100, m: m, h: h)
        return Path { path in
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: w, y: y))
        }
        .stroke(PA.Colors.hairline(0.18), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
    }

    private func scrubber(_ m: MultiSeriesChartModel, w: CGFloat, h: CGFloat) -> some View {
        let tsMs = m.tsAt(fraction: scrubFraction)
        let x = m.x(tsMs: tsMs, width: w)
        return ZStack {
            Path { path in
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: h))
            }
            .stroke(PA.Colors.hairline(0.2), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))

            ForEach(m.series) { s in
                let i = m.nearestIndex(in: s, tsMs: tsMs)
                if i < s.points.count {
                    let base = s.points.first?.price ?? 0
                    let pt = CGPoint(
                        x: m.x(tsMs: s.points[i].tsMs, width: w),
                        y: yPos(MultiSeriesChartModel.transform(price: s.points[i].price, base: base, scale: m.scale), m: m, h: h)
                    )
                    Circle()
                        .fill(s.color)
                        .frame(width: 9, height: 9)
                        .overlay(Circle().stroke(PA.Colors.background, lineWidth: 2))
                        .position(pt)
                }
            }
        }
    }

    private var emptyState: some View {
        RoundedRectangle(cornerRadius: 12)
            .stroke(PA.Colors.hairline(0.06), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
            .overlay(
                Text("Not enough data to chart.")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            )
    }

    // MARK: Axis labels (min / max)

    @ViewBuilder
    private func axisLabels(_ m: MultiSeriesChartModel) -> some View {
        if !m.isEmpty {
            VStack(alignment: .leading) {
                Text(m.scale == .indexed ? fmtSignedPct(m.maxVal - 100) : fmtUSD(m.maxVal))
                Spacer()
                Text(m.scale == .indexed ? fmtSignedPct(m.minVal - 100) : fmtUSD(m.minVal))
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(PA.Colors.muted)
            .padding(.vertical, 2)
            .padding(.leading, 2)
            .allowsHitTesting(false)
        }
    }

    // MARK: Scrub readout (floating)

    private func readoutCard(_ m: MultiSeriesChartModel) -> some View {
        let tsMs = m.tsAt(fraction: scrubFraction)
        return VStack(alignment: .leading, spacing: 5) {
            Text(dateLabel(tsMs))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
            ForEach(m.series) { s in
                let i = m.nearestIndex(in: s, tsMs: tsMs)
                if i < s.points.count {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Circle().fill(s.color).frame(width: 7, height: 7)
                            Text(s.label)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(PA.Colors.textSecondary)
                            Spacer(minLength: 12)
                            Text(fmtUSD(s.points[i].price))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(PA.Colors.text)
                        }
                        if showChangeDetails {
                            HStack(spacing: 10) {
                                if let start = m.changeFromStart(in: s, index: i) {
                                    deltaChip("start", start)
                                }
                                if let d24 = m.change24h(in: s, index: i) {
                                    deltaChip("24h", d24)
                                }
                            }
                            .padding(.leading, 13)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(PA.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(PA.Colors.hairline(0.08), lineWidth: 1))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 2)
        .padding(.top, 4)
        .transition(.opacity)
        .allowsHitTesting(false)
    }

    private func deltaChip(_ label: String, _ value: Double) -> some View {
        (Text("\(label) ").font(.system(size: 10)).foregroundColor(PA.Colors.muted)
            + Text(fmtSignedPct(value)).font(.system(size: 10, weight: .semibold)).foregroundColor(ChangeDirection.from(value).color))
    }

    // MARK: Legend (current value per series)

    private func legend(_ m: MultiSeriesChartModel) -> some View {
        FlowHStack(spacing: 14) {
            ForEach(m.series) { s in
                HStack(spacing: 6) {
                    Capsule().fill(s.color).frame(width: 14, height: 3)
                    Text(s.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(PA.Colors.textSecondary)
                    if let last = s.points.last {
                        Text(fmtUSD(last.price))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }
            }
        }
    }

    // MARK: Accessibility

    private func accessibilitySummary(_ m: MultiSeriesChartModel) -> String {
        guard !m.isEmpty else { return "no data" }
        return m.series.compactMap { s -> String? in
            guard let last = s.points.last?.price else { return nil }
            let change = m.changeFromStart(in: s, index: s.points.count - 1)
            let changeStr = change.map { String(format: ", %@ %.0f percent", ChangeDirection.from($0).accessibilityWord, abs($0)) } ?? ""
            return String(format: "%@ %@%@", s.label, fmtUSD(last), changeStr)
        }.joined(separator: ". ")
    }

    // MARK: Formatting

    private func fmtUSD(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = v >= 1000 ? 0 : 2
        return f.string(from: NSNumber(value: v)) ?? String(format: "$%.2f", v)
    }

    private func fmtSignedPct(_ v: Double) -> String {
        let a = abs(v)
        let body = a >= 10 ? String(format: "%.0f", a) : String(format: "%.1f", a)
        let sign = v > 0 ? "+" : (v < 0 ? "-" : "")
        return "\(sign)\(body)%"
    }

    private func dateLabel(_ tsMs: Double) -> String {
        let date = Date(timeIntervalSince1970: tsMs / 1000)
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }
}

// MARK: - Simple wrapping HStack for the legend

/// Minimal flow layout so a 4+ grade legend wraps instead of clipping.
private struct FlowHStack: Layout {
    var spacing: CGFloat = 12
    var rowSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for sv in subviews {
            let size = sv.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + rowSpacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for sv in subviews {
            let size = sv.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + rowSpacing
                rowHeight = 0
            }
            sv.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Previews

#Preview("Editions overlay") {
    let now = Date()
    MultiLineChartView(
        series: [
            MultiLineSeriesInput(
                id: "u",
                label: "Unlimited",
                color: PA.Colors.accent,
                points: (0..<30).map { i in
                    PricePoint(
                        ts: ISO8601DateFormatter().string(from: now.addingTimeInterval(Double(i - 29) * 86400)),
                        price: 120 + 1.4 * Double(i),
                        currency: "USD"
                    )
                }
            ),
            MultiLineSeriesInput(
                id: "f",
                label: "1st Edition",
                color: Color(red: 0.66, green: 0.55, blue: 0.98),
                points: (0..<30).map { i in
                    PricePoint(
                        ts: ISO8601DateFormatter().string(from: now.addingTimeInterval(Double(i - 29) * 86400)),
                        price: 230 - 0.7 * Double(i),
                        currency: "USD"
                    )
                }
            ),
        ],
        scale: .absolute,
        showChangeDetails: true,
        height: 160
    )
    .padding()
    .background(PA.Colors.background)
}
