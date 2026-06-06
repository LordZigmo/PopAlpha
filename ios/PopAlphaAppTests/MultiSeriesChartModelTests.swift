import XCTest
import SwiftUI
@testable import PopAlphaApp

/// Pure-logic coverage for the multi-series chart's layout/scrub math. The
/// SwiftUI view can't be unit-tested, but every number it renders comes from
/// `MultiSeriesChartModel`, so this is where correctness is enforced:
/// indexed rebasing, the time-based x-axis (the thing that differs from the
/// single-series index-based chart), nearest-point lookup, and the
/// from-start / 24h deltas surfaced in the scrub readout.
final class MultiSeriesChartModelTests: XCTestCase {

    private func makeSeries(
        _ id: String,
        _ prices: [Double],
        startMs: Double = 0,
        stepMs: Double = 86_400_000
    ) -> MultiSeriesChartModel.Series {
        let pts = prices.enumerated().map { i, p in
            MultiSeriesChartModel.Point(tsMs: startMs + Double(i) * stepMs, price: p)
        }
        return MultiSeriesChartModel.Series(id: id, label: id, color: .red, points: pts)
    }

    func testDropsSeriesWithFewerThanTwoPoints() {
        let m = MultiSeriesChartModel(
            series: [makeSeries("a", [10]), makeSeries("b", [10, 12])],
            scale: .absolute
        )
        XCTAssertEqual(m.series.count, 1)
        XCTAssertEqual(m.series.first?.id, "b")
    }

    func testAbsoluteDomainSpansAllSeries() {
        let m = MultiSeriesChartModel(
            series: [makeSeries("a", [10, 20, 15]), makeSeries("b", [50, 40])],
            scale: .absolute
        )
        XCTAssertEqual(m.minVal, 10, accuracy: 0.0001)
        XCTAssertEqual(m.maxVal, 50, accuracy: 0.0001)
    }

    func testIndexedRebasesEachSeriesTo100() {
        // a: 10→100, 20→200 ; b: 50→100, 40→80  → domain [80, 200]
        let m = MultiSeriesChartModel(
            series: [makeSeries("a", [10, 20]), makeSeries("b", [50, 40])],
            scale: .indexed
        )
        XCTAssertEqual(m.minVal, 80, accuracy: 0.0001)
        XCTAssertEqual(m.maxVal, 200, accuracy: 0.0001)
    }

    func testTransform() {
        XCTAssertEqual(MultiSeriesChartModel.transform(price: 200, base: 100, scale: .indexed), 200, accuracy: 0.0001)
        XCTAssertEqual(MultiSeriesChartModel.transform(price: 50, base: 200, scale: .indexed), 25, accuracy: 0.0001)
        XCTAssertEqual(MultiSeriesChartModel.transform(price: 200, base: 100, scale: .absolute), 200, accuracy: 0.0001)
        // base 0 falls back to the raw price (no divide-by-zero)
        XCTAssertEqual(MultiSeriesChartModel.transform(price: 50, base: 0, scale: .indexed), 50, accuracy: 0.0001)
    }

    func testChangeFromStartAndChange24h() {
        let m = MultiSeriesChartModel(series: [makeSeries("a", [100, 110, 99])], scale: .absolute)
        let s = m.series[0]
        XCTAssertEqual(m.changeFromStart(in: s, index: 1)!, 10, accuracy: 0.0001)
        XCTAssertEqual(m.changeFromStart(in: s, index: 2)!, -1, accuracy: 0.0001)
        XCTAssertEqual(m.change24h(in: s, index: 1)!, 10, accuracy: 0.0001)      // 100 → 110
        XCTAssertEqual(m.change24h(in: s, index: 2)!, -10, accuracy: 0.0001)     // 110 → 99
        XCTAssertNil(m.change24h(in: s, index: 0))                               // no prior day
    }

    func testNearestIndexByTimestamp() {
        let m = MultiSeriesChartModel(series: [makeSeries("a", [10, 11, 12, 13], startMs: 0, stepMs: 100)], scale: .absolute)
        let s = m.series[0]
        XCTAssertEqual(m.nearestIndex(in: s, tsMs: 0), 0)
        XCTAssertEqual(m.nearestIndex(in: s, tsMs: 149), 1)    // nearer 100 than 200
        XCTAssertEqual(m.nearestIndex(in: s, tsMs: 151), 2)
        XCTAssertEqual(m.nearestIndex(in: s, tsMs: 9_999), 3)  // clamps to last
    }

    func testXMappingSpansWidthByTime() {
        let m = MultiSeriesChartModel(series: [makeSeries("a", [10, 20], startMs: 1000, stepMs: 1000)], scale: .absolute)
        XCTAssertEqual(m.x(tsMs: 1000, width: 200), 0, accuracy: 0.0001)
        XCTAssertEqual(m.x(tsMs: 1500, width: 200), 100, accuracy: 0.0001)
        XCTAssertEqual(m.x(tsMs: 2000, width: 200), 200, accuracy: 0.0001)
    }

    func testTsAtFractionClamps() {
        let m = MultiSeriesChartModel(series: [makeSeries("a", [10, 20], startMs: 0, stepMs: 1000)], scale: .absolute)
        XCTAssertEqual(m.tsAt(fraction: 0), 0, accuracy: 0.0001)
        XCTAssertEqual(m.tsAt(fraction: 1), 1000, accuracy: 0.0001)
        XCTAssertEqual(m.tsAt(fraction: -1), 0, accuracy: 0.0001)    // clamped low
        XCTAssertEqual(m.tsAt(fraction: 2), 1000, accuracy: 0.0001)  // clamped high
    }

    func testEmptyModel() {
        let m = MultiSeriesChartModel(series: [], scale: .absolute)
        XCTAssertTrue(m.isEmpty)
    }

    func testTimeParsing() {
        XCTAssertNotNil(ChartTimeParsing.ms("2026-05-01T00:00:00.000Z"))
        XCTAssertNotNil(ChartTimeParsing.ms("2026-05-01T00:00:00Z"))
        XCTAssertNotNil(ChartTimeParsing.ms("2026-05-01"))
        XCTAssertNil(ChartTimeParsing.ms("not-a-date"))
        let day1 = ChartTimeParsing.ms("2026-05-01")!
        let day2 = ChartTimeParsing.ms("2026-05-02")!
        XCTAssertGreaterThan(day2, day1)
    }
}
