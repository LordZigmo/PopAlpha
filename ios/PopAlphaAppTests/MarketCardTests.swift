import XCTest
@testable import PopAlphaApp

/// MarketCard.stub is what bridges slug-only navigation (search results,
/// Universal Links) into the existing CardDetailView that wants a
/// hydrated MarketCard. Verifying its invariants prevents the stub
/// from regressing into a shape CardDetailView's loaders can't accept.
final class MarketCardTests: XCTestCase {
    func testStubUsesSlugAsId() {
        let card = MarketCard.stub(slug: "charizard-base-set-4")

        // CardDetailView reads `card.id` to drive its data fetches —
        // stub must round-trip the slug into id.
        XCTAssertEqual(card.id, "charizard-base-set-4")
    }

    func testStubDefaultsAreSafe() {
        let card = MarketCard.stub(slug: "any-slug")

        // Defaults must produce a renderable card even with zero
        // additional context. Empty strings + 0 prices + empty arrays
        // — never nil for required fields.
        XCTAssertEqual(card.name, "")
        XCTAssertEqual(card.setName, "")
        XCTAssertEqual(card.cardNumber, "")
        XCTAssertEqual(card.price, 0)
        XCTAssertEqual(card.changePct, 0)
        XCTAssertEqual(card.changeWindow, "24H")
        XCTAssertTrue(card.sparkline.isEmpty)
        XCTAssertTrue(card.imageGradient.isEmpty)
        XCTAssertNil(card.imageURL)
        XCTAssertNil(card.confidenceScore)
    }

    func testStubAcceptsAllOptionalFields() {
        let url = URL(string: "https://example.com/card.png")!
        let card = MarketCard.stub(
            slug: "pikachu-1999",
            name: "Pikachu",
            setName: "Base Set",
            cardNumber: "58",
            imageURL: url
        )

        XCTAssertEqual(card.id, "pikachu-1999")
        XCTAssertEqual(card.name, "Pikachu")
        XCTAssertEqual(card.setName, "Base Set")
        XCTAssertEqual(card.cardNumber, "58")
        XCTAssertEqual(card.imageURL, url)
    }
}
