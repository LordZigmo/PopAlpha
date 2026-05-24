import XCTest
@testable import PopAlphaApp

final class CardDetailPriceTrustTests: XCTestCase {
    func testNearMintHeroPrefersMetricsOverChartFallback() {
        let price = selectNearMintHeroPrice(
            isJapaneseCard: false,
            marketPrice: 90.22,
            activeCardPrice: 90.22,
            chartFallbackPrice: 2420,
            yahooJpPrice: nil,
            yahooJpSampleCount: nil,
            snkrdunkPrice: nil,
            snkrdunkSampleCount: nil
        )

        XCTAssertEqual(price, 90.22)
    }

    func testNearMintHeroDoesNotTrustThinJpSamplesOverMetrics() {
        let price = selectNearMintHeroPrice(
            isJapaneseCard: true,
            marketPrice: 90.22,
            activeCardPrice: 90.22,
            chartFallbackPrice: 2420,
            yahooJpPrice: 120,
            yahooJpSampleCount: 1,
            snkrdunkPrice: nil,
            snkrdunkSampleCount: nil
        )

        XCTAssertEqual(price, 90.22)
    }

    func testNearMintHeroCanUseQualifiedJpSource() {
        let price = selectNearMintHeroPrice(
            isJapaneseCard: true,
            marketPrice: 90.22,
            activeCardPrice: 90.22,
            chartFallbackPrice: 2420,
            yahooJpPrice: 120,
            yahooJpSampleCount: 3,
            snkrdunkPrice: 130,
            snkrdunkSampleCount: 4
        )

        XCTAssertEqual(price, 130)
    }
}
